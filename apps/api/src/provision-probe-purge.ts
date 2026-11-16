// DEVOS-234 (M2.4-d3c-2a, docs/modules/M2.4.md "M2.4-d3c-2 decisions"): the AT13 probe's purge through M2.5, as any
// project would be purged: Archive, then Purge, on the production ops, scanners and preflight list, under the M1.7
// policy with a KK grant (never `allowAll`, never a delete by name). Output is fixed codes only.
import type { PurgeOutcome } from "./provision-probe.js";
import { PROVISIONER_IDENTITY } from "./provision-runtime.js";

type Ops = { provider: string; kind: string };
type Scanner = { name: string };
type Authorize = (action: string, resource: string) => Promise<"allow" | "deny" | "require_approval">;

/** The `@devos/provision` teardown exports the probe uses, read structurally (the package is loaded at run time). */
export interface ProvisionTeardownModule {
  pinnedGitHub(gh: unknown): Promise<unknown>;
  pinnedCoolify(cf: unknown): Promise<unknown>;
  githubRepoOps(gh: unknown, projectId: string): Ops;
  githubDeployKeyOps(gh: unknown, projectId: string): Ops;
  coolifyProjectOps(cf: unknown, projectId: string): Ops;
  coolifyEnvironmentOps(cf: unknown, projectId: string): Ops;
  coolifyApplicationOps(cf: unknown, projectId: string): Ops;
  coolifyPrivateKeyOps(cf: unknown, projectId: string): Ops;
  coolifyPortOps(): Ops;
  backupScheduleOps(): Ops;
  githubScanner(gh: unknown): Scanner;
  coolifyScanner(cf: unknown): Scanner;
  githubTokenScopeCheck(gh: unknown, o: { owner: string }): () => Promise<void>;
  coolifyTokenScopeCheck(cf: unknown, recorded: () => Promise<readonly unknown[]>): () => Promise<void>;
}

/** The `@devos/teardown` exports the probe uses. */
export interface TeardownModule {
  archiveProject(projectId: string, o: Record<string, unknown>): Promise<unknown>;
  purgeProject(projectId: string, o: Record<string, unknown>): Promise<{ purged: boolean; report: { hits: { provider: string; kind: string }[]; errors: unknown[] } }>;
  inventoryScanner(store: unknown): Scanner;
  vaultScanner(db: unknown, timeoutMs?: number): Scanner;
}

export interface TeardownStoreLike {
  activeResources(projectId: string): Promise<readonly unknown[]>;
}

/**
 * Decision 2: the production teardown wiring, built once per purge from one pinned GitHub and one pinned Coolify
 * client (DEVOS-235 decision 4), so every op, scanner and check of that purge uses the same token snapshot.
 * M2.5-b (DEVOS-112) reuses it.
 */
export async function teardownWiring(
  pm: ProvisionTeardownModule,
  tm: TeardownModule,
  w: { gh: unknown; cf: unknown; store: TeardownStoreLike; db: unknown; projectId: string; owner: string; timeoutMs: number },
): Promise<{ ops: Ops[]; scanners: Scanner[]; preflight: (() => Promise<void>)[] }> {
  const gh = await pm.pinnedGitHub(w.gh);
  const cf = await pm.pinnedCoolify(w.cf);
  const id = w.projectId;
  return {
    ops: [
      pm.githubRepoOps(gh, id),
      pm.githubDeployKeyOps(gh, id),
      pm.coolifyProjectOps(cf, id),
      pm.coolifyEnvironmentOps(cf, id),
      pm.coolifyApplicationOps(cf, id),
      pm.coolifyPrivateKeyOps(cf, id),
      pm.coolifyPortOps(),
      pm.backupScheduleOps(),
    ],
    // Pre-review 1 (high): purgeProject needs a scanner per provider with ops. A backup schedule exists only as an
    // inventory row (nothing at a provider), which the inventory scanner already sees, so its own scan is empty.
    scanners: [tm.inventoryScanner(w.store), tm.vaultScanner(w.db, w.timeoutMs), pm.githubScanner(gh), pm.coolifyScanner(cf), BACKUP_SCHEDULE_SCANNER],
    preflight: [pm.githubTokenScopeCheck(gh, { owner: w.owner }), pm.coolifyTokenScopeCheck(cf, () => w.store.activeResources(id))],
  };
}

const BACKUP_SCHEDULE_SCANNER = { name: "backup_schedule", scan: async (): Promise<never[]> => [] };

/** The resource string `@devos/teardown` authorizes (its `check`), shared so the grant pre-check asks the same question. */
export const teardownResource = (projectId: string): string => `project:${projectId}`;

/** Decision 3: the actions the probe's KK grant must cover; one cycle uses one of each (more on a retried purge). */
export const PROBE_GRANT_ACTIONS = ["teardown.archive", "teardown.purge"] as const;

type GrantRow = { id: string; uses: number; maxUses: number };
type GrantProblem = (grant: any, request: { identity: { id: string; type: "system" }; action: { type: string; resource?: string; projectId?: string } }, now: number) => string | null;

/**
 * Decision 3: a usable KK grant for the probe's teardown, found read-only (nothing is consumed): the newest-expiring
 * grant on the probe project that `grantProblem` accepts for every action in PROBE_GRANT_ACTIONS, with at least
 * one use left per action. Null when there is none.
 */
export async function findProbeGrant(
  db: any, projectId: string, now: Date, timeoutMs: number, grantProblem: GrantProblem,
  actions: readonly string[] = PROBE_GRANT_ACTIONS,
): Promise<string | null> {
  const rows: GrantRow[] = await db.$transaction((tx: any) => tx.approvalGrant.findMany({
    where: { projectId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
    take: 20,
  }), { timeout: timeoutMs, maxWait: timeoutMs });
  for (const g of rows) {
    if (g.maxUses - g.uses < actions.length) continue;
    // Pre-review 2: the same resource string the engine is asked about (`project:<id>`).
    const ok = actions.every((type) => grantProblem(g, { identity: PROVISIONER_IDENTITY, action: { type, resource: teardownResource(projectId), projectId } }, now.getTime()) === null);
    if (ok) return g.id;
  }
  return null;
}

/** The M1.7 authorizer with the KK grant presented (policyAuthorizer's shape, plus `approvalGrantId`). */
export function grantAuthorizer(policy: { decide(r: unknown): Promise<{ enforcedOutcome: string }> }, projectId: string, grantId: string): Authorize {
  return async (action, resource) => {
    const d = await policy.decide({ identity: PROVISIONER_IDENTITY, action: { type: action, resource, projectId }, approvalGrantId: grantId });
    return d.enforcedOutcome === "allow" ? "allow" : d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

const KIND_RE = /^[a-z0-9_]{1,40}$/;

/**
 * Decision 1: a teardown stop as the probe reports it. Retryable stops are "in progress" (the next tick runs the
 * purge again, bounded by PROBE_PHASE_MAX_MS); anything else is a fixed code. Any other throw is rethrown, and
 * probeStep treats it as in progress until the phase limit (it never keeps the message).
 */
export function purgeStop(e: unknown): PurgeOutcome {
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown; resource?: { provider?: unknown; kind?: unknown } } | null;
  if (!x || x.name !== "TeardownError" || typeof x.code !== "string") throw e;
  if (x.retryable === true) return "in_progress";
  const where = typeof x.resource?.provider === "string" && typeof x.resource?.kind === "string" && KIND_RE.test(x.resource.provider) && KIND_RE.test(x.resource.kind)
    ? `:${x.resource.provider}/${x.resource.kind}` : "";
  switch (x.code) {
    case "provider_forbidden":
    case "approval_required":
    case "policy_denied":
      return { error: `purge-permission${x.code === "provider_forbidden" ? "" : `:${x.code}`}` };
    case "ownership_mismatch":
      return { error: `purge-ownership${where}` };
    case "scan_incomplete":
    case "unsupported_resource":
      return { error: `purge-incomplete:${x.code}${where}` };
    default:
      return { error: `purge-${x.code.replace(/_/g, "-")}`.slice(0, 60) };
  }
}

export interface ProbePurgeDeps {
  teardown: TeardownModule;
  /** The probe row's stage, read just before the purge. */
  stage(): Promise<string>;
  wiring(): Promise<{ ops: Ops[]; scanners: Scanner[]; preflight: (() => Promise<void>)[] }>;
  store: unknown;
  authorize: Authorize;
}

/** Decision 1: Archive (unless already archived), then Purge; `purged` with a clean scan is done. */
export async function probePurge(projectId: string, d: ProbePurgeDeps): Promise<PurgeOutcome> {
  const stage = await d.stage();
  if (stage === "purged") return "done";
  const w = await d.wiring();
  const base = { store: d.store, authorize: d.authorize, ops: w.ops };
  try {
    if (stage !== "archived") await d.teardown.archiveProject(projectId, base);
    const r = await d.teardown.purgeProject(projectId, { ...base, scanners: w.scanners, preflight: w.preflight });
    if (r.purged) return "done";
    const hit = r.report.hits[0];
    const where = hit && KIND_RE.test(hit.provider) && KIND_RE.test(hit.kind.replace(/^inventory:/, "")) ? `:${hit.provider}/${hit.kind.replace(/^inventory:/, "")}` : "";
    return { error: `purge-incomplete:${r.report.errors.length ? "scan-error" : "leftover"}${where}` };
  } catch (e) {
    return purgeStop(e);
  }
}

/** Decision 4 and 5: what a new cycle may start with. */
export type CycleStart = "ready" | "purge-pending" | { blocked: string };

/**
 * Decision 4: no usable grant → blocked (`probe-purge-not-approved`), so the probe creates nothing it cannot delete.
 * Decision 5: a `purged` probe row moves back to `intake` (only the probe's own row; ensureProbeProject has already
 * checked its `provision.probe_started` marker); an `archived` row (an earlier purge did not finish) starts the
 * cycle with the purge.
 */
export async function probeCycleStart(db: any, projectId: string, timeoutMs: number, hasGrant: () => Promise<boolean>): Promise<CycleStart> {
  if (!(await hasGrant())) return { blocked: "probe-purge-not-approved" };
  return db.$transaction(async (tx: any) => {
    const p = await tx.project.findUnique({ where: { id: projectId }, select: { stage: true } });
    if (!p) throw new Error("probe-project-missing");
    if (p.stage === "archived") return "purge-pending";
    // Pre-review 5: rows left by a cycle whose archive was refused (the stage never reached `archived`) are purged
    // first too, instead of a new cycle provisioning on top of them.
    if (p.stage !== "purged" && (await tx.resource.count({ where: { projectId, status: "active" } })) > 0) return "purge-pending";
    if (p.stage === "purged") {
      await tx.project.updateMany({ where: { id: projectId, stage: "purged" }, data: { stage: "intake", archivedAt: null, purgeAfter: null } });
      await tx.auditEvent.create({ data: { actor: "system", action: "provision.probe_reset", summary: "AT13 probe project back to intake for a new cycle", projectId } });
    }
    return "ready";
  }, { timeout: timeoutMs, maxWait: timeoutMs });
}

/** The probe row's stage, in one bounded read. */
export async function probeStage(db: any, projectId: string, timeoutMs: number): Promise<string> {
  const p = await db.$transaction((tx: any) => tx.project.findUnique({ where: { id: projectId }, select: { stage: true } }), { timeout: timeoutMs, maxWait: timeoutMs });
  if (!p) throw new Error("probe-project-missing");
  return String(p.stage);
}
