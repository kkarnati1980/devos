// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md "d1 runtime wiring"): builds the ProvisionSweepJob from the loaded
// @devos/provision module, the policy engine, the vault, the approvals core and the S4 isolation hook.
// @devos/provision, @devos/isolation and S3's apply() are loaded at run time by main.ts (like @devos/db), so the API
// typechecks without their `dist` and its typecheck/test/test:db scripts stay unchanged (floor guard, #117 ci-gate).
// The shapes below mirror the package's exports structurally. Nothing here logs a value: only fixed codes.
import { ProvisionSkip, ProvisionSweepJob, nameConflictCard, type ProvisioningProject } from "./provision-sweep.js";

type Step = { key: string };
type Decision = "allow" | "deny" | "require_approval";
type Authorize = (action: string, resource: string) => Promise<Decision>;
type Store = { assertLockHeld(projectId: string): Promise<void> };
type Range = { from: number; to: number };
type ApplyTemplate = (o: { out: string; select?: string[]; sha?: string }) => { code: number; error?: string };
type AfterStack = (project: { id: string; slug: string }, env: { name: "preview" | "live"; port: number; portRangeStart: number; compose: unknown }) => Promise<{ compose: Record<string, unknown> }>;
type P = { id: string; slug: string; name: string };

/** The subset of `@devos/provision` the wiring uses. */
export interface ProvisionModule {
  GitHubClient: new (o: { token: () => Promise<string> }) => unknown;
  CoolifyClient: new (o: { origin: string; token: () => Promise<string> }) => unknown;
  PrismaStore: new (db: unknown, o: { databaseUrl: string }) => Store;
  parsePortRange(raw: string | undefined): Range;
  coreTemplateFiles(apply: ApplyTemplate, o: { devosSha: string }): unknown[];
  runProvision(projectId: string, steps: Step[], o: { store: Store; authorize: Authorize }): Promise<unknown>;
  githubRepoStep(gh: unknown, p: P, owner: string): Step;
  coolifyProjectStep(cf: unknown, p: { id: string; slug: string }): Step;
  githubCoreStep(gh: unknown, p: { slug: string }, owner: string, files: unknown[], version: string, assertLock: () => Promise<void>): Step;
  stackSteps(cf: unknown, store: Store, p: P, range: Range): Step[];
  deployKeySteps(gh: unknown, cf: unknown, store: Store, p: P, owner: string): Step[];
  applicationSteps(cf: unknown, gh: unknown, store: Store, p: P, o: { owner: string; serverUuid: string; tailnetIp: string; range: Range; hooks: { afterStack: AfterStack } }): Step[];
  appSecretSteps(cf: unknown, store: Store, secrets: ProjectSecrets, p: P): Step[];
  /** M2.4-d3a: the `backup_schedule/nightly` inventory record (decision 9). */
  backupScheduleStep(store: Store, p: { id: string; slug: string }): Step;
}

export interface ProjectSecrets {
  has(projectId: string, name: string): Promise<boolean>;
  put(projectId: string, name: string, value: string): Promise<void>;
  matches(projectId: string, name: string, candidate: string): Promise<boolean>;
}

/** Only what the wiring needs from the API's Vault. */
export interface ProvisionVault {
  reveal(name: "github_token" | "coolify_api_token"): Promise<string | null>;
  hasProject(projectId: string, name: string): Promise<boolean>;
  putProject(projectId: string, name: string, value: string): Promise<unknown>;
  matchesProject(projectId: string, name: string, candidate: string): Promise<boolean>;
}

export interface ProvisionPolicy {
  decide(r: { identity: { id: string; type: "system" }; action: { type: string; resource: string; projectId?: string } }): Promise<{ enforcedOutcome: string }>;
}

/** The projects the sweep reads and moves. */
export interface ProvisioningRows {
  listProvisioning(exclude: readonly string[]): Promise<ProvisioningProject[]>;
  markBuilding(projectId: string): Promise<void>;
  /**
   * DEVOS-244 (Codex PR179-r2): true when the project was archived or purged. Optional; when present, every create
   * of a sweep run asks it first (under the run's project lock), so a run that started from a stale snapshot never
   * writes to a provider after Archive.
   */
  isArchived?(projectId: string): Promise<boolean>;
}

export const PROVISIONER_IDENTITY = { id: "system:provisioner", type: "system" as const };
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const UUID_LIKE_RE = /^[A-Za-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

export interface ProvisionConfig {
  owner: string;
  coolifyOrigin: string;
  serverUuid: string;
  tailnetIp: string;
  devosSha: string;
  portsRaw: string | undefined;
}

/** Reads the sweep's configuration by name; a missing or malformed value is a fixed code, never the value. */
export function provisionConfig(env: NodeJS.ProcessEnv): ProvisionConfig | { off: string } {
  const owner = env.DEVOS_GITHUB_OWNER ?? "";
  const coolifyOrigin = env.DEVOS_COOLIFY_URL ?? "";
  const serverUuid = env.DEVOS_COOLIFY_SERVER_UUID ?? "";
  const tailnetIp = env.DEVOS_TAILNET_IP ?? "";
  const devosSha = env.GIT_SHA ?? "";
  if (!OWNER_RE.test(owner)) return { off: "provision-github-owner-not-set" };
  let origin: URL | null = null;
  try { origin = new URL(coolifyOrigin); } catch { origin = null; }
  if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:") || origin.pathname !== "/" || origin.search || origin.username) {
    return { off: "provision-coolify-url-not-set" };
  }
  if (!UUID_LIKE_RE.test(serverUuid)) return { off: "provision-coolify-server-not-set" };
  // Codex PR145-r3: the address must be a tailnet (CGNAT, 100.64.0.0/10) address, the same rule as M2.4-c2's
  // isTailnetIpv4, or every project's step list would throw `tailnet-ip-invalid` and park after five ticks.
  if (!IPV4_RE.test(tailnetIp)) return { off: "provision-tailnet-ip-not-set" };
  const [o1 = -1, o2 = -1] = tailnetIp.split(".").map(Number);
  if (o1 !== 100 || o2 < 64 || o2 > 127) return { off: "provision-tailnet-ip-not-tailnet" };
  if (!SHA_RE.test(devosSha)) return { off: "provision-devos-sha-unknown" };
  return { owner, coolifyOrigin: origin.origin, serverUuid, tailnetIp, devosSha, portsRaw: env.DEVOS_PROJECT_PORTS };
}

/**
 * DEVOS-244 (Codex PR179-r2): the sweep snapshots its projects before running them one by one, and Archive can run in
 * between under the same project lock. Each create therefore re-reads the stage first: an archived or purged project
 * (or a read that fails) throws, so runProvision stops before any provider write without parking the project.
 */
export function notArchived(rows: Pick<ProvisioningRows, "isArchived">, projectId: string, inner: Authorize): Authorize {
  if (!rows.isArchived) return inner;
  const check = rows.isArchived.bind(rows);
  // Codex PR179-r3: a plain throw, not "deny". The runner stops before the write either way, but a deny would be a
  // non-retryable policy_denied that parks the project in the sweep, so a later Restore (or a transient read error)
  // would leave it parked. An archived project is a ProvisionSkip (PR179-r4): the sweep neither counts nor parks it, and
  // it drops out of the next listing (`archivedAt: null`); a failed read is an ordinary retryable failure.
  return async (action, resource) => {
    let archived: boolean;
    try { archived = await check(projectId); } catch { throw new Error("provision-stage-unreadable"); }
    if (archived) throw new ProvisionSkip("provision-project-archived");
    return inner(action, resource);
  };
}

/** M1.7 on every create: `provision.<provider>.<kind>` on `project:<id>/…`; anything but allow stops the step. */
export function policyAuthorizer(policy: ProvisionPolicy, projectId: string): Authorize {
  return async (action, resource) => {
    const d = await policy.decide({ identity: PROVISIONER_IDENTITY, action: { type: action, resource, projectId } });
    return d.enforcedOutcome === "allow" ? "allow" : d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

export const vaultToken = (vault: ProvisionVault, name: "github_token" | "coolify_api_token") => async (): Promise<string> => {
  const v = await vault.reveal(name);
  if (!v) throw new Error(`${name}-not-set`);
  return v;
};

export interface ProvisionWiring {
  mod: ProvisionModule;
  apply: ApplyTemplate;
  afterStack: AfterStack;
  db: unknown;
  databaseUrl: string;
  vault: ProvisionVault | null;
  policy: ProvisionPolicy;
  rows: ProvisioningRows;
  raiseCard(card: ReturnType<typeof nameConflictCard>): Promise<unknown>;
  log(e: { level: "info" | "warn"; msg: string; projectId?: string; code?: string; step?: string }): void;
  env: NodeJS.ProcessEnv;
}

/** The provisioner for one project at a time: its step list, store and policy check (M2.4-d3b reuses it for the AT13 probe). */
export interface Provisioner {
  store: Store;
  steps(p: ProvisioningProject): Step[];
  /** Runs every step for `p` under its lock, with M1.7 on every create. Throws the runner's StepError on a stop. */
  run(p: ProvisioningProject): Promise<unknown>;
  /** Both provider tokens are in the vault (read by name, never logged), or a fixed code. */
  ready(): Promise<string | null>;
}

/**
 * The provisioner, or `{ off }` with a fixed code: no vault, or a missing setting. It never runs with
 * `allowAll` (fail closed, ADR-0006); every create goes through the policy engine.
 */
export function buildProvisioner(w: ProvisionWiring): Provisioner | { off: string } {
  if (!w.vault) return { off: "provision-vault-not-configured" };
  const cfg = provisionConfig(w.env);
  if ("off" in cfg) return cfg;
  const { mod, vault } = w;
  let range: Range;
  try { range = mod.parsePortRange(cfg.portsRaw); } catch { return { off: "provision-port-range-invalid" }; }
  const gh = new mod.GitHubClient({ token: vaultToken(vault, "github_token") });
  const cf = new mod.CoolifyClient({ origin: cfg.coolifyOrigin, token: vaultToken(vault, "coolify_api_token") });
  const store = new mod.PrismaStore(w.db, { databaseUrl: w.databaseUrl });
  const secrets: ProjectSecrets = {
    has: (id, n) => vault.hasProject(id, n),
    put: async (id, n, v) => { await vault.putProject(id, n, v); },
    matches: (id, n, c) => vault.matchesProject(id, n, c),
  };
  const appOpts = { owner: cfg.owner, serverUuid: cfg.serverUuid, tailnetIp: cfg.tailnetIp, range, hooks: { afterStack: w.afterStack } };
  // The S3 core is generated once per run (a temp dir, removed after reading), so a template change needs a deploy.
  const steps = (p: ProvisioningProject): Step[] => {
    const files = mod.coreTemplateFiles(w.apply, { devosSha: cfg.devosSha });
    return [
      mod.githubRepoStep(gh, p, cfg.owner),
      mod.githubCoreStep(gh, p, cfg.owner, files, cfg.devosSha.slice(0, 12), () => store.assertLockHeld(p.id)),
      // stackSteps holds only environments and ports; they need the Coolify project's done row (PR145-r1).
      mod.coolifyProjectStep(cf, p),
      ...mod.stackSteps(cf, store, p, range),
      ...mod.deployKeySteps(gh, cf, store, p, cfg.owner),
      ...mod.applicationSteps(cf, gh, store, p, appOpts),
      ...mod.appSecretSteps(cf, store, secrets, p),
      mod.backupScheduleStep(store, p),
    ];
  };
  return {
    store,
    steps,
    run: (p) => mod.runProvision(p.id, steps(p), { store, authorize: notArchived(w.rows, p.id, policyAuthorizer(w.policy, p.id)) }),
    // Both provider tokens must be in the vault before any project runs: a missing one would otherwise be a
    // non-retryable provider_error and park the project (pre-review M1).
    ready: async () => {
      if (!(await vault.reveal("github_token"))) return "provision-github-token-not-set";
      if (!(await vault.reveal("coolify_api_token"))) return "provision-coolify-token-not-set";
      return null;
    },
  };
}

/** The provisioning sweep over every live `provisioning` project, or `{ off }` with a fixed code. */
export function buildProvisionSweep(w: ProvisionWiring): ProvisionSweepJob | { off: string } {
  const pv = buildProvisioner(w);
  if ("off" in pv) return pv;
  return new ProvisionSweepJob({
    listProvisioning: (exclude) => w.rows.listProvisioning(exclude),
    provision: (p) => pv.run(p),
    markBuilding: (id) => w.rows.markBuilding(id),
    ready: () => pv.ready(),
    raiseNameConflict: async (p, step) => { await w.raiseCard(nameConflictCard(p, step)); },
    log: w.log,
  });
}

/** Postgres rows for the sweep: live (not paused, not archived) `provisioning` projects, oldest first. */
export class PrismaProvisioningRows implements ProvisioningRows {
  constructor(private readonly db: any, private readonly timeoutMs: number) {}

  // Every call is bounded (ADR-0011 §9): a stalled read must not hold the sweep's tick forever (pre-review M2).
  async listProvisioning(exclude: readonly string[] = []): Promise<ProvisioningProject[]> {
    const t = this.timeoutMs;
    const rows: { id: string; slug: string; name: string }[] = await this.db.$transaction((tx: any) => tx.project.findMany({
      where: { stage: "provisioning", pausedAt: null, archivedAt: null, ...(exclude.length ? { id: { notIn: [...exclude] } } : {}) },
      select: { id: true, slug: true, name: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    }), { timeout: t, maxWait: t });
    return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
  }

  async isArchived(projectId: string): Promise<boolean> {
    const t = this.timeoutMs;
    const p: { stage: unknown; archivedAt: Date | null } | null = await this.db.$transaction((tx: any) => tx.project.findUnique({ where: { id: projectId }, select: { stage: true, archivedAt: true } }), { timeout: t, maxWait: t });
    return !p || p.archivedAt !== null || ["archived", "purged"].includes(String(p.stage));
  }

  async markBuilding(projectId: string): Promise<void> {
    const t = this.timeoutMs;
    // M2.4-d3a: the budget record. The move and its audit row commit together, and only the one move from
    // `provisioning` writes it, so a re-run or a second tick never records the budget twice.
    await this.db.$transaction(async (tx: any) => {
      const moved = await tx.project.updateMany({ where: { id: projectId, stage: "provisioning", pausedAt: null, archivedAt: null }, data: { stage: "building" } });
      if (moved.count !== 1) return;
      const p: { capUsd: unknown } | null = await tx.project.findUnique({ where: { id: projectId }, select: { capUsd: true } });
      const cap = Number(p?.capUsd ?? Number.NaN);
      await tx.auditEvent.create({
        data: {
          actor: "system",
          action: "provision.budget_recorded",
          summary: Number.isFinite(cap) ? `Provisioned with a project budget cap of $${cap.toFixed(2)}` : "Provisioned; the project budget cap could not be read",
          details: { capUsd: Number.isFinite(cap) ? cap.toFixed(6) : null },
          projectId,
        },
      });
    }, { timeout: t, maxWait: t });
  }
}
