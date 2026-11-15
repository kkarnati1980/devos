// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md "d1 runtime wiring"): builds the ProvisionSweepJob from the loaded
// @devos/provision module, the policy engine, the vault, the approvals core and the S4 isolation hook.
// @devos/provision, @devos/isolation and S3's apply() are loaded at run time by main.ts (like @devos/db), so the API
// typechecks without their `dist` and its typecheck/test/test:db scripts stay unchanged (floor guard, #117 ci-gate).
// The shapes below mirror the package's exports structurally. Nothing here logs a value: only fixed codes.
import { ProvisionSweepJob, nameConflictCard, type ProvisioningProject } from "./provision-sweep.js";

type Step = { key: string };
type Decision = "allow" | "deny" | "require_approval";
type Authorize = (action: string, resource: string) => Promise<Decision>;
type Store = { assertLockHeld(projectId: string): Promise<void> };
type Range = { start: number; end: number };
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
  githubCoreStep(gh: unknown, p: { slug: string }, owner: string, files: unknown[], version: string, assertLock: () => Promise<void>): Step;
  stackSteps(cf: unknown, store: Store, p: P, range: Range): Step[];
  deployKeySteps(gh: unknown, cf: unknown, store: Store, p: P, owner: string): Step[];
  applicationSteps(cf: unknown, gh: unknown, store: Store, p: P, o: { owner: string; serverUuid: string; tailnetIp: string; range: Range; hooks: { afterStack: AfterStack } }): Step[];
  appSecretSteps(cf: unknown, store: Store, secrets: ProjectSecrets, p: P): Step[];
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
  listProvisioning(): Promise<ProvisioningProject[]>;
  markBuilding(projectId: string): Promise<void>;
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
  if (!IPV4_RE.test(tailnetIp)) return { off: "provision-tailnet-ip-not-set" };
  if (!SHA_RE.test(devosSha)) return { off: "provision-devos-sha-unknown" };
  return { owner, coolifyOrigin: origin.origin, serverUuid, tailnetIp, devosSha, portsRaw: env.DEVOS_PROJECT_PORTS };
}

/** M1.7 on every create: `provision.<provider>.<kind>` on `project:<id>/…`; anything but allow stops the step. */
export function policyAuthorizer(policy: ProvisionPolicy, projectId: string): Authorize {
  return async (action, resource) => {
    const d = await policy.decide({ identity: PROVISIONER_IDENTITY, action: { type: action, resource, projectId } });
    return d.enforcedOutcome === "allow" ? "allow" : d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

const vaultToken = (vault: ProvisionVault, name: "github_token" | "coolify_api_token") => async (): Promise<string> => {
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

/**
 * The provisioning sweep, or `{ off }` with a fixed code: no vault, or a missing setting. It never runs with
 * `allowAll` (fail closed, ADR-0006); every create goes through the policy engine.
 */
export function buildProvisionSweep(w: ProvisionWiring): ProvisionSweepJob | { off: string } {
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
      ...mod.stackSteps(cf, store, p, range),
      ...mod.deployKeySteps(gh, cf, store, p, cfg.owner),
      ...mod.applicationSteps(cf, gh, store, p, appOpts),
      ...mod.appSecretSteps(cf, store, secrets, p),
    ];
  };
  return new ProvisionSweepJob({
    listProvisioning: () => w.rows.listProvisioning(),
    provision: (p) => mod.runProvision(p.id, steps(p), { store, authorize: policyAuthorizer(w.policy, p.id) }),
    markBuilding: (id) => w.rows.markBuilding(id),
    raiseNameConflict: async (projectId, step) => {
      const p = (await w.rows.listProvisioning()).find((x) => x.id === projectId);
      if (p) await w.raiseCard(nameConflictCard(p, step));
    },
    log: w.log,
  });
}

/** Postgres rows for the sweep: live (not paused, not archived) `provisioning` projects, oldest first. */
export class PrismaProvisioningRows implements ProvisioningRows {
  constructor(private readonly db: any, private readonly timeoutMs: number) {}

  async listProvisioning(): Promise<ProvisioningProject[]> {
    const rows: { id: string; slug: string; name: string }[] = await this.db.project.findMany({
      where: { stage: "provisioning", pausedAt: null, archivedAt: null },
      select: { id: true, slug: true, name: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
  }

  async markBuilding(projectId: string): Promise<void> {
    const t = this.timeoutMs;
    await this.db.$transaction((tx: any) => tx.project.updateMany({ where: { id: projectId, stage: "provisioning" }, data: { stage: "building" } }), { timeout: t, maxWait: t });
  }
}
