// Runtime wiring of the database-backed parts (readiness + policy engine), kept out of main.ts so it is testable.
// Secrets are read by name only and never logged.
import { PolicyEngine, PrismaPolicyStore, type PrismaLike } from "@devos/policy";
import type { KkSessionRegistry } from "./auth.js";
import { stdoutSink, withTimeout } from "./http.js";
import type { GrantService, ReadinessProbe, SetupServices } from "./routes.js";
import { PrismaSettingsStore, writeAudit } from "./settings.js";
import type { DeadLetterQueue, DeadLetterServices } from "./dead-letters.js";
import { Approvals, ApprovalError, PrismaApprovalStore, gateFromRules, type GateName, type GrantIssuer } from "./approvals.js";
import type { ApprovalRouteServices, GrantSummary } from "./approvals-routes.js";
import type { NotifyServices } from "./notify-routes.js";
import { Notifier, PrismaNotificationStore, parseDashboardUrl } from "./notify.js";
import { parseSmtpConfig } from "./smtp.js";
import { ExpiringRequirementsPipeline, approvalStepBoundMs, type ExpiryLog, type PendingCardLister } from "./requirements-expiry.js";
import { PrismaRequirementsStore } from "./requirements-store.js";
import type { RequirementsServices } from "./requirements.js";
import { RequirementsSyncJob, skipDecidedQuestions, syncIntervalMs, type DecidedCardLister } from "./requirements-sync.js";
import { PrismaVaultStore, Vault, parseVaultKey, parseVaultKeyVersion } from "./vault.js";
import type { ModelRunner } from "@devos/analyst";
import { ANTHROPIC_KEY_NAME } from "./analyst-adapter.js";
import { AnalystRunSweepJob, PrismaAnalystRunRows, PrismaAnalystRunSweeper, runEngineModelRunner, type AnalystRowsDb, type RunExecutor } from "./analyst-runner.js";

/** The subset of the Prisma client the API needs. */
export interface DbClient extends PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { isolationLevel?: string; timeout?: number; maxWait?: number }): Promise<T>;
}

/**
 * Readiness database probe with a bounded database operation (ADR-0011 §9, PR14-r1): the connection
 * wait is bounded by `maxWait`, the transaction by `timeout`, and `SELECT 1` by a transaction-local
 * `statement_timeout`, so a stalled database ends the operation itself, not only the wrapper.
 * The outer `withTimeout` keeps the HTTP answer within the same limit.
 */
export function dbReadiness(db: DbClient, timeoutMs: number): ReadinessProbe {
  return () =>
    withTimeout(
      () =>
        db.$transaction(
          async (t: any) => {
            await t.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout`;
            await t.$queryRaw`SELECT 1 AS ready`;
          },
          { timeout: timeoutMs, maxWait: timeoutMs },
        ),
      timeoutMs,
      "db-timeout",
    ).then(() => undefined);
}

/**
 * M2.2-d3a (pre-review finding 1): a spec save upserts up to 2 000 requirement rows in one transaction, so it gets
 * its own bound instead of the short outbound timeout; the same 30 s the spec route allows for the body.
 */
export const REQUIREMENTS_TX_MS = 30_000;

export interface Runtime {
  grants: GrantService | null;
  readiness: ReadinessProbe;
  /** M1.4: settings need the database; the vault also needs `DEVOS_VAULT_KEY`. */
  setup: SetupServices;
  /** M1.6: notifications need the database; the bell and email also need their configuration. */
  notify: NotifyServices;
  /** DEVOS-77: the dead-letter view needs `REDIS_URL` (the run queue) and the database (audit). */
  deadLetters: DeadLetterServices;
  /** M2.3-b1: the approvals inbox needs the database and the policy engine. */
  approvals: ApprovalRouteServices;
  /** M2.2-d3a: spec intake needs the database and the approvals core (its cards). */
  requirements: RequirementsServices;
  /** M2.2-d3c1: the periodic `syncApproval` job, present only when spec intake is wired; main.ts starts it. */
  requirementsSync: RequirementsSyncJob | null;
  /** DEVOS-171: closes analyst runs left open past max_seconds + grace (start-up and every 5 min); main.ts starts it. */
  analystSweep: AnalystRunSweepJob | null;
}

const notReady = (code: string): ReadinessProbe => async () => {
  throw new Error(code);
};

/**
 * Builds readiness and the grant service from the environment. Both `DATABASE_URL` and
 * `DEVOS_POLICY_HMAC_KEY` are required configuration (M1.2): if either is missing, grants are
 * disabled AND `/ready` is 503, so a deployment never reports ready while approvals cannot work.
 */
export async function buildRuntime(
  env: NodeJS.ProcessEnv,
  opts: {
    outboundTimeoutMs: number;
    kkSessions: KkSessionRegistry;
    loadDb: (url: string) => Promise<DbClient>;
    /** DEVOS-77: opens M1.5's RunQueue on `REDIS_URL` (absent → no dead-letter view). */
    loadQueue?: (redisUrl: string) => Promise<DeadLetterQueue>;
    /**
     * M2.2-d3b1: builds M1.5's RunEngine (with the Anthropic adapter) over this database and policy engine for the
     * analyst model pass. Absent → model pass off. main.ts supplies it when `DEVOS_ANALYST_MODEL_PASS=on` (then the setting decides per call, DEVOS-176),
     * importing the run engine at runtime like @devos/db, so the API typechecks on its own. `apiKey` reads the vault.
     */
    loadAnalystEngine?: (db: DbClient, policy: PolicyEngine, apiKey: () => Promise<string | null>) => Promise<RunExecutor>;
  },
): Promise<Runtime> {
  const databaseUrl = env.DATABASE_URL;
  const hmac = env.DEVOS_POLICY_HMAC_KEY;
  // A malformed vault key stops start-up with a code (never the value), even before the database.
  const vaultKey = parseVaultKey(env.DEVOS_VAULT_KEY);
  const vaultKeyVersion = parseVaultKeyVersion(env.DEVOS_VAULT_KEY_VERSION);
  // M1.6: a malformed SMTP setting or dashboard URL also stops start-up with a code.
  const smtp = parseSmtpConfig(env);
  const dashboardUrl = parseDashboardUrl(env.DEVOS_DASHBOARD_URL);
  const redisUrl = parseRedisUrl(env.REDIS_URL);
  const noSetup: SetupServices = { settings: null, vault: null };
  const noNotify: NotifyServices = { notifier: null };
  const noDead: DeadLetterServices = { queue: null, audit: null };
  const noApprovals: ApprovalRouteServices = { approvals: null, grantsFor: null, revokeGrant: null };
  const noRequirements: RequirementsServices = { pipeline: null, store: null, cards: null };
  const off = { setup: noSetup, notify: noNotify, deadLetters: noDead, approvals: noApprovals, requirements: noRequirements, requirementsSync: null, analystSweep: null };
  if (!databaseUrl) return { grants: null, readiness: notReady("database-not-configured"), ...off };
  if (!hmac) return { grants: null, readiness: notReady("policy-not-configured"), ...off };
  const db = await opts.loadDb(databaseUrl);
  const setup: SetupServices = {
    settings: new PrismaSettingsStore(db, opts.outboundTimeoutMs),
    vault: vaultKey ? new Vault(new PrismaVaultStore(db, opts.outboundTimeoutMs), vaultKey, vaultKeyVersion) : null,
  };
  const engine = new PolicyEngine({
    store: new PrismaPolicyStore(db),
    hmacKey: Buffer.from(hmac, "utf8"),
    verifyKkSession: opts.kkSessions.verify,
  });
  const grants = engine as unknown as GrantService;
  const vault = setup.vault;
  const notifier = new Notifier(new PrismaNotificationStore(db, opts.outboundTimeoutMs), {
    // The bell key and SMTP password are vault secrets (entered in the wizard), read at send time.
    secrets: vault
      ? { reveal: (name) => vault.reveal(name), isSet: async (name) => (await vault.list()).some((m) => m.name === name && m.set) }
      : null,
    smtp,
    dashboardUrl,
    timeoutMs: opts.outboundTimeoutMs,
  });
  const t = opts.outboundTimeoutMs;
  const deadLetters: DeadLetterServices =
    redisUrl && opts.loadQueue
      ? {
          queue: await opts.loadQueue(redisUrl),
          // Bounded like every other write (ADR-0011 §9): connection wait and transaction both capped.
          audit: (entry) => db.$transaction((tx: any) => writeAudit(tx, entry), { timeout: t, maxWait: t }),
        }
      : noDead;
  // M2.3-b1: the approvals core over Postgres, the same engine for grants, and M1.6 for the "new card" notice.
  const approvalStore = new PrismaApprovalStore(db, t);
  const approvalsCore = new Approvals({
    store: approvalStore,
    grants: engine as unknown as GrantIssuer,
    notifier,
    verifyKkSession: opts.kkSessions.verify,
    // DEVOS-134: a policy card's gate comes from the matched rules' `constraints.gateName`.
    gateForRules: (ids) => gateForRulesFromDb(db, ids, t),
  });
  const approvals: ApprovalRouteServices = {
    approvals: approvalsCore,
    grantsFor: (approvalId) => grantsForApproval(db, approvalId, t),
    revokeGrant: (session, grantId) => engine.revokeGrant(session as Parameters<PolicyEngine["revokeGrant"]>[0], grantId),
  };
  // M2.2-d3b1: the model pass is one M1.5 run per call (role analyst, Sonnet); the engine reserves, meters and records cost.
  const runner: ModelRunner | null = opts.loadAnalystEngine
    ? runEngineModelRunner(
        new PrismaAnalystRunRows(db as unknown as AnalystRowsDb, t),
        // M2.2-d3b2: the Anthropic key is read from the vault by name at call time; no vault → null → assist-failed.
        await opts.loadAnalystEngine(db, engine, async () => (vault ? vault.reveal(ANTHROPIC_KEY_NAME) : null)),
      )
    : null;
  const requirementsStore = new PrismaRequirementsStore(db as ConstructorParameters<typeof PrismaRequirementsStore>[0], Math.max(t, REQUIREMENTS_TX_MS));
  // Codex PR88-r5: one expiry write can wait up to maxWait for a connection and then run up to timeout, so the hold
  // reserves the approvals store's whole step bound (built with `t` above), not its transaction timeout alone.
  const requirements = requirementsServices(requirementsStore, approvalsCore, approvalStore, runner, (e) => stdoutSink({ ts: new Date().toISOString(), ...e }), approvalStepBoundMs(approvalStore),
    // DEVOS-176: the `analyst.model_pass` setting, read before each pass (a change applies without a restart).
    async () => (await setup.settings!.get()).analystModelPass);
  const requirementsSync = new RequirementsSyncJob(requirements, requirementsStore, (e) => stdoutSink({ ts: new Date().toISOString(), ...e }), syncIntervalMs(env.DEVOS_REQUIREMENTS_SYNC_MS));
  const analystSweep = new AnalystRunSweepJob(new PrismaAnalystRunSweeper(db as unknown as AnalystRowsDb, t), (e) => stdoutSink({ ts: new Date().toISOString(), ...e }));
  return { grants, readiness: dbReadiness(db, opts.outboundTimeoutMs), setup, notify: { notifier }, deadLetters, approvals, requirements, requirementsSync, analystSweep };
}

/**
 * M2.2-d3a (contract M2.2, "M2.2-d3a — Behaviour"): the analyst pipeline over Postgres, raising its cards through
 * the M2.3 approvals core (dedupe against a pending twin, the KK notice) and reading decisions from the same store.
 * Question cards block no task (no tasks exist at intake, and the core accepts only task ids). The model pass runs
 * only when a run-backed runner is supplied (M2.2-d3b1); without one, analysis is deterministic only.
 */
export function requirementsServices(
  store: NonNullable<RequirementsServices["store"]>,
  approvals: Pick<Approvals, "raiseCard" | "expireCardsById">,
  cards: { get(id: string): Promise<{ id: string; gate: string; status: string } | null> } & DecidedCardLister & PendingCardLister,
  runner: ModelRunner | null = null,
  expiryLog?: ExpiryLog,
  /** The longest one expiry write can take, connection wait included (`approvalStepBoundMs`; Codex PR88-r4, PR88-r5, PR88-r6). */
  expireStepMs = 0,
  /** DEVOS-176: the `analyst.model_pass` setting read per call. Absent with a runner → off (pre-review finding 1:
   * a dropped argument must never turn model spend on). */
  modelPassOn?: () => Promise<boolean>,
): RequirementsServices {
  // M2.2-d3c2: after each submission, the superseded version's pending cards and an unlinked requirements card
  // are expired through the M2.3 core (DEVOS-164).
  const pipeline = new ExpiringRequirementsPipeline(
    {
      store,
      raiseRequirementsCard: async (card) => ({ id: (await approvals.raiseCard(card)).id }),
      // M2.2-d3c1: a question KK already approved or rejected in an earlier version is not asked again.
      raiseQuestionCard: skipDecidedQuestions(async (draft, reason) => ({ id: (await approvals.raiseCard({ ...draft.card, reason })).id }), cards),
      runner,
      modelPassOn: modelPassOn ?? (async () => false),
    },
    {
      latestDoc: (id) => store.latestDoc(id),
      cards,
      expire: (ids, reason) => approvals.expireCardsById(ids, reason),
      // The Postgres store holds the project row for the pass (Codex PR88-r1); the in-memory store has no lock.
      serialize: holder(store, expireStepMs),
    },
    expiryLog,
  );
  return { pipeline, store, cards: { get: (id) => cards.get(id) } };
}

type HeldFn<T> = (assertHeld: () => void) => Promise<T>;
type Held = { withProjectHeld?<T>(projectId: string, fn: HeldFn<T>, stepMs?: number): Promise<T> };
/** The store's project hold, when it has one (PrismaRequirementsStore does). */
function holder(store: object, stepMs: number): (<T>(projectId: string, fn: HeldFn<T>) => Promise<T>) | undefined {
  const s = store as Held;
  return typeof s.withProjectHeld === "function" ? (id, fn) => s.withProjectHeld!(id, fn, stepMs) : undefined;
}

/**
 * M1.7's grant rows for one card, newest first, bounded like every other read (ADR-0011 §9). Codex PR60-r1: the
 * live grants (not revoked, not expired) are read in full, separately from the 20 newest history rows, so a burst
 * of revoked race losers can never push a live grant out of the window the summary and the revoke route see.
 */
export function grantsForApproval(db: DbClient, approvalId: string, timeoutMs: number, now: () => number = Date.now): Promise<GrantSummary[]> {
  const select = { id: true, scopeAction: true, scopeResource: true, projectId: true, sha: true, issuedAt: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true };
  const orderBy = [{ issuedAt: "desc" }, { id: "desc" }];
  return db.$transaction(
    async (tx: any) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout`;
      const live = await tx.approvalGrant.findMany({ where: { approvalId, revokedAt: null, expiresAt: { gt: new Date(now()) } }, orderBy, select });
      const recent = await tx.approvalGrant.findMany({ where: { approvalId }, orderBy, take: 20, select });
      const byId = new Map<string, GrantSummary & { issuedAt: Date }>();
      for (const g of [...live, ...recent]) byId.set(g.id, g);
      return [...byId.values()]
        .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1))
        .map(({ issuedAt: _i, ...g }) => g);
    },
    { timeout: timeoutMs, maxWait: timeoutMs },
  );
}

/**
 * DEVOS-134: reads the matched `policy_rule` rows (id and constraints only) and picks the card's gate with
 * `gateFromRules`. Bounded like every other read (ADR-0011 §9). No ids → no read. More than 100 ids is refused rather
 * than truncated (a dropped rule could weaken the gate); the engine matches far fewer.
 */
export async function gateForRulesFromDb(db: DbClient, ids: readonly string[], timeoutMs: number): Promise<GateName | null> {
  const unique = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0))];
  if (unique.length === 0) return null;
  if (unique.length > 100) throw new ApprovalError("gate-rules-too-many", 500);
  const rows = await db.$transaction(
    async (tx: any) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout`;
      return tx.policyRule.findMany({ where: { id: { in: unique } }, select: { id: true, constraints: true } });
    },
    { timeout: timeoutMs, maxWait: timeoutMs },
  );
  return gateFromRules(unique, rows as { id: string; constraints: { gateName?: unknown } | null }[]);
}

/** `REDIS_URL`: absent → null (no dead-letter view); anything but redis:// or rediss:// stops start-up. */
export function parseRedisUrl(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  // Parsed, not pattern-matched (PR36-r1): scheme redis/rediss, a host, and a port that is absent or
  // 1–65535. `redis://redis:bad` and `redis:///` are rejected here, not by the driver at connect time.
  const bad = () => new Error("config-redis-url-invalid");
  if (/\s/.test(s)) throw bad();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad();
  }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw bad();
  if (!u.hostname) throw bad();
  if (u.port && !(/^\d{1,5}$/.test(u.port) && Number(u.port) >= 1 && Number(u.port) <= 65535)) throw bad();
  return s;
}
