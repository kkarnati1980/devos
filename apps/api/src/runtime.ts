// Runtime wiring of the database-backed parts (readiness + policy engine), kept out of main.ts so it is testable.
// Secrets are read by name only and never logged.
import { PolicyEngine, PrismaPolicyStore, type PrismaLike } from "@devos/policy";
import type { KkSessionRegistry } from "./auth.js";
import { withTimeout } from "./http.js";
import type { GrantService, ReadinessProbe, SetupServices } from "./routes.js";
import { PrismaSettingsStore, writeAudit } from "./settings.js";
import type { DeadLetterQueue, DeadLetterServices } from "./dead-letters.js";
import type { NotifyServices } from "./notify-routes.js";
import { Notifier, PrismaNotificationStore, parseDashboardUrl } from "./notify.js";
import { parseSmtpConfig } from "./smtp.js";
import { PrismaVaultStore, Vault, parseVaultKey, parseVaultKeyVersion } from "./vault.js";

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

export interface Runtime {
  grants: GrantService | null;
  readiness: ReadinessProbe;
  /** M1.4: settings need the database; the vault also needs `DEVOS_VAULT_KEY`. */
  setup: SetupServices;
  /** M1.6: notifications need the database; the bell and email also need their configuration. */
  notify: NotifyServices;
  /** DEVOS-77: the dead-letter view needs `REDIS_URL` (the run queue) and the database (audit). */
  deadLetters: DeadLetterServices;
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
  if (!databaseUrl) return { grants: null, readiness: notReady("database-not-configured"), setup: noSetup, notify: noNotify, deadLetters: noDead };
  if (!hmac) return { grants: null, readiness: notReady("policy-not-configured"), setup: noSetup, notify: noNotify, deadLetters: noDead };
  const db = await opts.loadDb(databaseUrl);
  const setup: SetupServices = {
    settings: new PrismaSettingsStore(db, opts.outboundTimeoutMs),
    vault: vaultKey ? new Vault(new PrismaVaultStore(db, opts.outboundTimeoutMs), vaultKey, vaultKeyVersion) : null,
  };
  const grants = new PolicyEngine({
    store: new PrismaPolicyStore(db),
    hmacKey: Buffer.from(hmac, "utf8"),
    verifyKkSession: opts.kkSessions.verify,
  }) as unknown as GrantService;
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
  return { grants, readiness: dbReadiness(db, opts.outboundTimeoutMs), setup, notify: { notifier }, deadLetters };
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
