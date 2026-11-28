// DEVOS-234 (M2.4-d3c-2a, docs/modules/M2.4.md "M2.4-d3c-2 decisions"): the AT13 probe's purge through M2.5, as any
// project would be purged: Archive, then Purge, on the production ops, scanners and preflight list, under the M1.7
// policy with a KK grant (never `allowAll`, never a delete by name). Output is fixed codes only.
import { PROBE_SLUG, type CardOutcome, type PurgeOutcome } from "./provision-probe.js";
import { purgeCard } from "./teardown-sweep.js";
import { PROVISIONER_IDENTITY } from "./provision-runtime.js";

type Authorize = (action: string, resource: string) => Promise<"allow" | "deny" | "require_approval">;

// The wiring itself lives in teardown-wiring.ts (M2.5-b1); re-exported so existing imports keep working.
export { teardownWiring, teardownResource } from "./teardown-wiring.js";
export type { ProvisionTeardownModule, TeardownModule, TeardownStoreLike } from "./teardown-wiring.js";
import { teardownResource } from "./teardown-wiring.js";
import type { Ops, ProvisionTeardownModule, Scanner, TeardownModule, TeardownStoreLike } from "./teardown-wiring.js";

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
  actions: readonly string[] = PROBE_GRANT_ACTIONS, spare = 0,
): Promise<string | null> {
  const rows: GrantRow[] = await db.$transaction((tx: any) => tx.approvalGrant.findMany({
    // Codex PR239-r5 (high): never a grant issued for a `teardown.purge` card. That grant is the sweep's (M2.5-b2,
    // DEVOS-254): the probe spending it would bypass the sweep's archive check and use up the card's one use.
    where: {
      projectId, revokedAt: null, expiresAt: { gt: now },
      OR: [{ approvalId: null }, { approval: { is: { action: { not: "teardown.purge" } } } }],
    },
    orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
    take: 20,
  }), { timeout: timeoutMs, maxWait: timeoutMs });
  for (const g of rows) {
    // Codex PR239-r8: `spare` uses are kept for a later step of the same cycle (decision 11).
    if (g.maxUses - g.uses < actions.length + spare) continue;
    // Pre-review 2: the same resource string the engine is asked about (`project:<id>`).
    const ok = actions.every((type) => grantProblem(g, { identity: PROVISIONER_IDENTITY, action: { type, resource: teardownResource(projectId), projectId } }, now.getTime()) === null);
    if (ok) return g.id;
  }
  return null;
}

type PolicyRules = { mode: "observe" | "enforce"; rules: readonly unknown[] };
type Evaluate = (request: any, rules: readonly any[], mode: any, now: number) => { outcome: string; enforcedOutcome: string };

/**
 * Codex PR239-r19 (high, DEVOS-254 decision 18): true only when the active M1.7 policy would *use* the probe grant for
 * every action: evaluated read-only (rules loaded, nothing persisted, no grant consumed) with the same rules
 * evaluator `PolicyEngine.decide` runs, a grant is applied exactly when the outcome needs approval and the enforced
 * outcome is not a deny. A policy that allows a teardown action outright (no approval gate) or denies it would make
 * `grantAuthorizer` refuse, so the probe must not provision what it then could not clean up. A rule change after
 * this check is the d3c-2a case: the purge fails closed and the next cycle starts with the purge.
 */
export async function policyUsesProbeGrant(
  load: () => Promise<PolicyRules>, evaluate: Evaluate, projectId: string, now: Date, actions: readonly string[] = PROBE_GRANT_ACTIONS,
): Promise<boolean> {
  const { mode, rules } = await load();
  return actions.every((type) => {
    const ev = evaluate({ identity: PROVISIONER_IDENTITY, action: { type, resource: teardownResource(projectId), projectId } }, rules, mode, now.getTime());
    const needsApproval = ev.outcome === "require_approval" || ev.enforcedOutcome === "require_approval";
    return needsApproval && ev.enforcedOutcome !== "deny";
  });
}

/** The M1.7 authorizer with the KK grant presented (policyAuthorizer's shape, plus `approvalGrantId`). */
export function grantAuthorizer(policy: { decide(r: unknown): Promise<{ enforcedOutcome: string; approvalGrantId?: string | null }> }, projectId: string, grantId: string): Authorize {
  return async (action, resource) => {
    const d = await policy.decide({ identity: PROVISIONER_IDENTITY, action: { type: action, resource, projectId }, approvalGrantId: grantId });
    // Codex PR239-r18 (high): "allow" only when M1.7 allowed by using KK's probe grant, as the sweep's
    // `purgeCardAuthorizer` does; an allow that did not consume it (an un-gated allow, e.g. observe mode, or a policy
    // that needs no approval) is "require_approval", never a probe Archive or purge without the grant.
    if (d.enforcedOutcome === "allow") return d.approvalGrantId === grantId ? "allow" : "require_approval";
    return d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

const KIND_RE = /^[a-z0-9_]{1,40}$/;

/**
 * DEVOS-21 diagnostics, part 2: which purge preflight refused, and why, as a fixed code. `purgeProject` wraps a
 * preflight throw as `purge preflight: <message>`, and the two checks (`githubTokenScopeCheck`,
 * `coolifyTokenScopeCheck` in @devos/provision) start every message with their own code. Only the codes below are
 * ever printed, never the message; an unknown reason keeps the token's name, an unknown check reads plain.
 */
const PREFLIGHT_REASONS: readonly [token: "github" | "coolify", needle: string, code: string][] = [
  ["github", "cannot read its account's repository counts", "github-counts"],
  ["github", "belongs to another account than the repository owner", "github-owner"],
  ["github", "the repository list is unreadable", "github-list"],
  ["github", "owned repositories; give it access to all repositories", "github-repos"],
  ["github", "the classic token has no repo scope", "github-scopes"],
  ["coolify", "a recorded Coolify project id is not a uuid", "coolify-id"],
  ["coolify", "cannot see this project's Coolify project", "coolify-team"],
  ["coolify", "returned an inconclusive answer", "coolify-answer"],
];

export function preflightReason(message: unknown): string {
  if (typeof message !== "string") return "";
  const m = /^purge preflight: (github|coolify)-token-scope: /.exec(message);
  if (m) {
    const hit = PREFLIGHT_REASONS.find(([t, needle]) => t === m[1] && message.includes(needle));
    return `:${hit ? hit[2] : m[1]}`;
  }
  // Pre-review 1: the transport (@devos/provision http.ts) throws a non-transient ProviderError for a missing token
  // and for every non-2xx answer but 404, so an expired or revoked token reaches here as teardown's wrap of that
  // message (`<provider> token is not available from the vault`, `<provider> GET <path> returned <status>`).
  const p = /^purge preflight: (github|coolify) (token is not available from the vault$|GET \/\S* returned (\d{3})$)?/.exec(message);
  if (!p) return "";
  if (p[2]?.startsWith("token")) return `:${p[1]}-no-token`;
  if (p[3] === "401" || p[3] === "403" || p[3] === "422") return `:${p[1]}-http-${p[3]}`;
  return `:${p[1]}`;
}

/**
 * Decision 1: a teardown stop as the probe reports it. Retryable stops are "in progress" (the next tick runs the
 * purge again, bounded by PROBE_PHASE_MAX_MS); anything else is a fixed code. Any other throw is rethrown, and
 * probeStep treats it as in progress until the phase limit (it never keeps the message).
 */
export function purgeStop(e: unknown): PurgeOutcome {
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown; message?: unknown; resource?: { provider?: unknown; kind?: unknown } } | null;
  if (!x || x.name !== "TeardownError" || typeof x.code !== "string") throw e;
  if (x.retryable === true) return "in_progress";
  const where = typeof x.resource?.provider === "string" && typeof x.resource?.kind === "string" && KIND_RE.test(x.resource.provider) && KIND_RE.test(x.resource.kind)
    ? `:${x.resource.provider}/${x.resource.kind}` : "";
  switch (x.code) {
    case "provider_forbidden":
      // DEVOS-21 diagnostics: name the refusing provider and kind, so the KK step names the right token. A refusal
      // with no resource comes only from the purge preflight (teardown.ts), so it reads `:preflight`; a
      // resource whose provider or kind is outside KIND_RE reads `:resource` (pre-review 1).
      // Part 2: a preflight refusal also names the token and the reason (`:preflight:github-owner`, ...).
      // Part 12: cycle 18 ended `purge-permission:coolify/application` with a key that has every permission box, so
      // a resource refusal also names the teardown stage and the status (`:archive:http-403`), from teardown's
      // fixed form only (`<stage> of <resource> was refused by <provider> (http <nnn>): ...`).
      if (where) {
        const full = `purge-permission${where}${forbiddenTail(x.message)}`;
        return { error: full.length <= 120 ? full : `purge-permission${where}` };
      }
      return { error: `purge-permission${x.resource ? ":resource" : `:preflight${preflightReason(x.message)}`}` };
    case "approval_required":
    case "policy_denied":
      return { error: `purge-permission:${x.code}` };
    case "ownership_mismatch":
      return { error: `purge-ownership${where}` };
    case "scan_incomplete":
    case "unsupported_resource":
      return { error: `purge-incomplete:${x.code}${where}` };
    case "provider_error":
      // DEVOS-21 part 9: cycle 13 (22f564e) ended `purge-provider-error` with nothing more, so the failing purge
      // step was unknown. A final provider_error now names the resource kind, the teardown stage and the cause.
    {
      // The CLI hides a detail over 120 characters whole, so a tail that would overflow is dropped.
      const full = `purge-provider-error${where}${where ? providerErrorTail(x.message) : ""}`;
      return { error: full.length <= 120 ? full : `purge-provider-error${where}` };
    }
    default:
      return { error: `purge-${x.code.replace(/_/g, "-")}`.slice(0, 60) };
  }
}

/**
 * DEVOS-21 part 9: the stage and cause of teardown's final provider_error, read from its own fixed message forms
 * only (`<stage> of <resource> failed: <msg>`, teardown.ts writeError). The resource description and any other text
 * are never kept: only the stage word, an HTTP status from the transport's `returned <nnn>` ending, `no-token`, or a
 * known lowercase reason code (teardown shows only its REASON_CODES, every one of which ends `-invalid`; the
 * shape is checked here too, so an id-like slug in a provider message is never echoed; pre-review 1).
 */
const PURGE_STAGES = ["lookup", "archive", "restore", "delete"] as const;
export function providerErrorTail(message: unknown): string {
  if (typeof message !== "string") return "";
  const stage = PURGE_STAGES.find((s) => message.startsWith(`${s} of `));
  if (!stage) return "";
  // Codex PR233-r1 (low): the fixed form needs its ` failed: ` separator; without it the form is unknown, so only
  // the resource kind is reported (no stage).
  const i = message.lastIndexOf(" failed: ");
  if (i < 0) return "";
  const msg = message.slice(i + " failed: ".length);
  const status = / returned (\d{3})$/.exec(msg)?.[1];
  const cause = status ? `http-${status}`
    : /token is not available from the vault$/.test(msg) ? "no-token"
    : /^[a-z0-9]+(-[a-z0-9]+){0,4}-invalid$/.test(msg) && msg.length <= 40 ? msg
    : msg === "unexpected error" ? "unexpected"
    : msg ? "provider" : "";
  return `:${stage}${cause ? `:${cause}` : ""}`;
}

/**
 * DEVOS-21 part 12: the stage and status of teardown's resource refusal (`writeError` in
 * `packages/teardown/src/teardown.ts`). Only the stage word and a 401/403 status are kept; the resource description
 * and any other text never are. Another form gives the stage alone, or nothing.
 */
export function forbiddenTail(message: unknown): string {
  if (typeof message !== "string") return "";
  const stage = PURGE_STAGES.find((s) => message.startsWith(`${s} of `));
  if (!stage) return "";
  const status = / was refused by [a-z0-9-]+ \(http (401|403)\): the token lacks the permission$/.exec(message)?.[1];
  return `:${stage}${status ? `:http-${status}` : ""}`;
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
    // DEVOS-254 pre-review r2 3: the sweep's purge under KK's card may have won the project lock and finished first.
    const c = (e as { name?: unknown; code?: unknown } | null);
    if (c && c.name === "TeardownError" && c.code === "not_archived" && (await d.stage().catch(() => "")) === "purged") return "done";
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
export async function probeCycleStart(db: any, projectId: string, timeoutMs: number, hasGrant: () => Promise<boolean>, policyGated?: () => Promise<boolean>): Promise<CycleStart> {
  // Codex PR239-r19 (high): a grant the active policy would not use cannot authorize the cleanup, so the cycle is
  // blocked before anything is created. A fixed code of its own: a new grant card would not help, so none is raised.
  if (policyGated && !(await policyGated())) return { blocked: "probe-purge-policy-ungated" };
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

/**
 * Codex PR239-r7/r8 (medium, DEVOS-254 decision 11): true when a probe grant is still valid at `until` for both
 * `teardown.*` actions, with every use the rest of a card cycle may spend: the card's Archive (unless the row is already
 * archived), then a fallback purge, which after a Restore needs an Archive and a purge again. So a card KK rejects, lets
 * expire or answers with a Restore is still cleaned up by the probe under its own grant. Read-only, bounded reads.
 * Codex PR239-r11: no extra uses are kept for purge retries. A retry inside the purge phase's d3c-2a bound may spend any
 * use left over; past the bound, or past the grant, the cycle ends `purge-failed` or `purge-permission` and the next
 * cycle starts with the purge (`purge-pending`), as for every probe cycle.
 */
export async function probeGrantOutlasts(db: any, projectId: string, until: Date, timeoutMs: number, grantProblem: GrantProblem): Promise<boolean> {
  const stage = await probeStage(db, projectId, timeoutMs);
  const spare = stage === "archived" ? 0 : 1;
  return (await findProbeGrant(db, projectId, until, timeoutMs, grantProblem, PROBE_GRANT_ACTIONS, spare)) !== null;
}

/** DEVOS-110 decision 2: a rejected (or approved, then revoked) grant card is not raised again for one probe cycle. */
export const PROBE_CARD_REASK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * DEVOS-110 decision 1: the probe's one grant card. Every word is fixed here; only the probe's own row id goes in,
 * and nothing read from a provider or the server. The action is not a purge action (gate 5 stays for real purges);
 * approving it issues the fixed `teardown.*` grant (approvals.ts `PROBE_GRANT_SCOPE`).
 */
export function probeGrantCard(projectId: string): {
  gate: "destructive_or_spend"; action: "teardown.probe-grant"; target: string; reason: string; consequence: string; projectId: string;
} {
  return {
    gate: "destructive_or_spend",
    action: "teardown.probe-grant",
    target: teardownResource(projectId),
    reason:
      "DevOS runs a weekly self-test (the AT13 provisioning probe). It creates a throwaway test project, checks it was set up correctly, then deletes it again. " +
      "To delete its own test resources it needs your permission once. Approving lets the probe archive and delete only its own throwaway test project " +
      "(devos-probe-m24) for 90 days, at most 30 times. It cannot touch any real project.",
    consequence:
      "If you approve: the weekly self-test runs and cleans up after itself. If you reject: the self-test stays off and DevOS asks again in 7 days. " +
      "Nothing is deleted either way except the probe's own test resources.",
    projectId,
  };
}

/** The approvals surface the probe needs (structural; `Approvals` / `ApprovalStore`). */
export interface ProbeCardDeps {
  list(f: { action: string; target: string; limit: number }): Promise<{ status: string; decidedAt: Date | null; createdAt: Date }[]>;
  raise(card: ReturnType<typeof probeGrantCard>): Promise<unknown>;
}

/**
 * DEVOS-110 decision 2: raise the grant card when none is pending and none was rejected in the last 7 days.
 * Returns whether a card was raised. A failure is rethrown; the caller keeps the cycle blocked either way.
 */
export async function raiseProbeGrantCard(projectId: string, now: Date, d: ProbeCardDeps): Promise<boolean> {
  const card = probeGrantCard(projectId);
  const cards = await d.list({ action: card.action, target: card.target, limit: 50 });
  if (cards.some((c) => c.status === "pending")) return false;
  const since = now.getTime() - PROBE_CARD_REASK_MS;
  // Pre-review 3: a card approved in the last 7 days whose grant is gone (KK revoked it) is a "no" too, like a rejection.
  if (cards.some((c) => (c.status === "rejected" || c.status === "approved") && (c.decidedAt ?? c.createdAt).getTime() > since)) return false;
  await d.raise(card);
  return true;
}

/**
 * DEVOS-110: a cycle start that, when blocked for want of a grant, raises the grant card. The cycle stays blocked
 * (nothing is created); a card that could not be raised shows as `probe-purge-not-approved:card-failed`.
 */
export async function cycleStartWithCard(start: () => Promise<CycleStart>, raise: () => Promise<boolean>): Promise<CycleStart> {
  const s = await start();
  if (typeof s !== "object" || s.blocked !== "probe-purge-not-approved") return s;
  try {
    await raise();
    return s;
  } catch {
    return { blocked: "probe-purge-not-approved:card-failed" };
  }
}

/**
 * DEVOS-254 decision 1: true while no probe cycle has ended `pass-card` (read on the probe's own phase log only), so
 * the next cycle purges `devos-probe-m24` through KK's purge card (AT10). Once one has, cycles purge directly again.
 */
export async function probeCardCycle(db: any, projectId: string, timeoutMs: number): Promise<boolean> {
  const n: number = await db.$transaction((tx: any) => tx.auditEvent.count({
    where: { projectId, action: "provision.probe_phase", details: { path: ["result", "code"], equals: "pass-card" } },
  }), { timeout: timeoutMs, maxWait: timeoutMs });
  return n === 0;
}

const CARD_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

/** Codex PR239-r1 (medium): the purge card this archive already has, in one bounded read. */
export async function probeExistingCard(db: any, projectId: string, since: Date, timeoutMs: number): Promise<string | null> {
  const c = await db.$transaction((tx: any) => tx.approval.findFirst({
    where: { projectId, action: "teardown.purge", target: `project:${projectId}`, createdAt: { gte: since } },
    // Codex PR239-r2: the oldest, so a card raised by someone else first is the one tracked.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  }), { timeout: timeoutMs, maxWait: timeoutMs });
  return c && typeof c.id === "string" && c.id !== "" ? c.id : null;
}

/** Codex PR239-r15: the fixed reason the probe gives when it expires its own purge cards. */
export const PROBE_CARD_EXPIRE_REASON = "AT13 probe: purged by the probe itself, or superseded by a later archive (DEVOS-254)";

/**
 * Codex PR239-r15 (medium): expire the probe project's pending `teardown.purge` cards on `project:<id>` (only those
 * raised before `before`, when given) through `Approvals.expireCardsById`, then read again: resolves only when none is
 * left pending, so a caller never purges, or raises, past a pending card. Bounded reads (ADR-0011 §9), at most 50 ids.
 */
export async function expireProbePurgeCards(db: any, projectId: string, timeoutMs: number, expire: (ids: string[], reason: string) => Promise<string[]>, before?: Date): Promise<void> {
  const pending = async (): Promise<string[]> => {
    const rows: { id: unknown }[] = await db.$transaction((tx: any) => tx.approval.findMany({
      where: { projectId, action: "teardown.purge", target: `project:${projectId}`, status: "pending", ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: 50,
    }), { timeout: timeoutMs, maxWait: timeoutMs });
    return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && id !== "");
  };
  const ids = await pending();
  if (!ids.length) return;
  await expire(ids, PROBE_CARD_EXPIRE_REASON);
  if ((await pending()).length) throw new Error("probe-card-still-pending");
}

/** DEVOS-254 decision 4: the probe row's stage and its purge card's status, in one bounded read. */
export async function probeCardOutcome(db: any, projectId: string, cardId: string, timeoutMs: number): Promise<CardOutcome> {
  return db.$transaction(async (tx: any) => {
    const p = await tx.project.findUnique({ where: { id: projectId }, select: { stage: true, archivedAt: true } });
    if (!p) throw new Error("probe-project-missing");
    const c = await tx.approval.findUnique({ where: { id: cardId }, select: { status: true, decidedAt: true, createdAt: true, projectId: true, action: true } });
    // Only this project's own purge card counts; anything else reads as missing.
    // Codex PR239-r6: and only while the row is still in the archive the card was raised for. A Restore clears
    // `archived_at` and a new Archive sets a later one, so a tracked card older than the row's `archived_at` belongs to
    // an earlier archive: it reads as missing, and the cycle ends as a failed card cycle, never `pass-card`.
    const sameArchive = p.archivedAt instanceof Date && c?.createdAt instanceof Date && c.createdAt.getTime() >= p.archivedAt.getTime();
    const ok = c && sameArchive && c.projectId === projectId && c.action === "teardown.purge" && (CARD_STATUSES as readonly string[]).includes(String(c.status));
    // Codex PR239-r3 (medium): the sweep purges under the newest approved purge card of the archive
    // (`Approvals.list`, createdAt desc), which may be a later twin of the tracked one. So the cards that count are
    // this project's approved `teardown.purge` cards on `project:<id>` raised at or after the tracked card (the same
    // archive, pre-review 2), newest first; the newest one gives the status and decision time reported.
    const approved: { id: string; decidedAt: unknown }[] = ok && c.createdAt instanceof Date
      ? await tx.approval.findMany({
        where: { projectId, action: "teardown.purge", target: `project:${projectId}`, status: "approved", createdAt: { gte: c.createdAt } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, decidedAt: true },
        take: 20,
      })
      : [];
    const ids = new Set(approved.map((a) => a.id).filter((id) => typeof id === "string" && id !== ""));
    // Codex PR239-r1 (high): AT10 needs the purge to have run under an approved card's grant. Every allowed
    // `teardown.purge` decision for this project since the tracked card was raised must carry a grant issued for one of
    // those cards, and there must be one: a purge under the probe's grant or any other card's never counts.
    let byCard = false;
    if (ok && ids.size > 0 && String(p.stage) === "purged") {
      const ds: { approvalGrant: { approvalId: string | null } | null }[] = await tx.policyDecision.findMany({
        where: { projectId, ts: { gte: c.createdAt }, enforcedOutcome: "allow", action: { path: ["request", "type"], equals: "teardown.purge" } },
        select: { approvalGrant: { select: { approvalId: true } } },
        orderBy: { ts: "asc" },
        take: 50,
      });
      byCard = ds.length > 0 && ds.length < 50 && ds.every((x) => typeof x.approvalGrant?.approvalId === "string" && ids.has(x.approvalGrant.approvalId));
    }
    const newest = approved[0];
    const decided = newest ? newest.decidedAt : ok ? c.decidedAt : null;
    return {
      stage: String(p.stage),
      card: !ok ? "missing" : newest ? "approved" : (String(c.status) as CardOutcome["card"]),
      decidedAt: decided instanceof Date ? decided.toISOString() : null,
      // Codex PR239-r12: when the tracked card was raised, so the wait is measured from the card, not from the tick
      // that recorded it.
      raisedAt: ok && c.createdAt instanceof Date ? c.createdAt.toISOString() : null,
      byCard,
    };
  }, { timeout: timeoutMs, maxWait: timeoutMs });
}

export interface ProbePurgeCardDeps {
  stage(): Promise<string>;
  /** The row's `archived_at` (pre-review 2: a card raised before it belongs to an earlier archive). */
  archivedAt(): Promise<Date | null>;
  /** The id of the oldest `teardown.purge` card of this project raised at or after `since`, any status, or null. */
  existing(since: Date): Promise<string | null>;
  /** Archive under the probe's KK grant (`teardown.archive` only); called only when the row is not archived yet. */
  archive(): Promise<void>;
  /** The per-provider counts of the probe's active resources (the card's "what will be deleted"). */
  counts(): Promise<Record<string, number>>;
  /**
   * Decision 31 (Codex PR239-r33): `Approvals.raiseGuardedCard(card, { projectId, archivedAt, due: false })`, the M2.5-b5a
   * raise that re-reads the row and writes the card in one transaction under the project lifecycle lock, only while the
   * row is still archived with exactly `archivedAt`. It dedupes a pending twin, so a retried tick gets the same card. A
   * refusal (`not_archived`, `archive-changed`, `project-not-found`) writes nothing.
   */
  raise(card: ReturnType<typeof purgeCard>, archivedAt: Date): Promise<{ id: string; createdAt?: Date } | { refused: string }>;
  /**
   * Codex PR239-r7/r8 (decision 11): true when the probe grant outlasts the card wait and the purge after it. Asked
   * only before a new card is raised, never when this archive already has one (a retried tick keeps its card).
   */
  outlasts(): Promise<boolean>;
  /**
   * Codex PR239-r15: expire this project's pending purge cards raised before `before` (an earlier archive's), so
   * `raiseCard`'s pending-twin dedupe cannot hand back a stale card (`probe-card-stale`). Throws when one stays pending.
   */
  expireStale(before: Date): Promise<void>;
}

/** Decision 11: no new card was raised, because the probe grant would lapse before the probe could purge after it. */
export const CARD_GRANT_SHORT = { grantShort: true } as const;

/**
 * DEVOS-254 decision 3: Archive (unless archived), then raise the M2.5-b2 purge card unchanged (gate 5, `teardown.purge`,
 * `project:<id>`, fixed wording). The probe never approves it and never purges under it: the sweep job does, once KK
 * approves it in the inbox. Returns the card's id.
 */
export async function raiseProbePurgeCard(projectId: string, d: ProbePurgeCardDeps): Promise<string | typeof CARD_GRANT_SHORT> {
  const stage = await d.stage();
  // The Archive takes the lifecycle lock itself and releases it before the guarded raise (decision 31) takes it again.
  if (stage !== "archived" && stage !== "purged") await d.archive();
  // Decision 31 (Codex PR239-r33, replaces r19's session lock around these checks): the checks below only choose
  // whether to ask; the card itself is written by the guarded raise, which re-checks the archive under the lifecycle
  // lock in the same transaction, so a Restore, Purge or new Archive after these reads refuses the raise.
  return raiseChecked(projectId, d);
}

async function raiseChecked(projectId: string, d: ProbePurgeCardDeps): Promise<string | typeof CARD_GRANT_SHORT> {
  const now = await d.stage();
  // Codex PR239-r1 (medium): a tick that raised the card but did not record its id is retried. The card this archive
  // already has (any status: KK may have approved it, the sweep may have purged) is used again, never a second one.
  const since = await d.archivedAt();
  if ((now === "archived" || now === "purged") && since instanceof Date) {
    const had = await d.existing(since);
    if (had) return had;
  }
  if (now === "purged") throw new Error("probe-card-already-purged");
  if (now !== "archived") throw new Error("probe-card-not-archived");
  if (!(since instanceof Date)) throw new Error("probe-card-stale");
  // Codex PR239-r8: checked after the lookup above, so a card raised by an earlier tick is never given up here.
  let lasts = false;
  try { lasts = (await d.outlasts()) === true; } catch { lasts = false; }
  if (!lasts) return CARD_GRANT_SHORT;
  await d.expireStale(since);
  const raised = await d.raise(purgeCard({ id: projectId, slug: PROBE_SLUG }, await d.counts()), since);
  if (raised && "refused" in raised) throw new Error(`probe-card-refused-${raised.refused}`);
  const card = raised;
  if (!card || typeof card.id !== "string" || card.id === "") throw new Error("probe-card-not-raised");
  // Pre-review 2: `raiseCard` dedupes against a pending twin. One left from an earlier archive (the sweep was off and
  // nothing expired it) would be skipped by the sweep (`card-before-archive`), so it is not used.
  const archived = await d.archivedAt();
  if (!(archived instanceof Date) || !(card.createdAt instanceof Date) || card.createdAt.getTime() < archived.getTime()) throw new Error("probe-card-stale");
  // Codex PR239-r12/r13: the card is bound to the archive read after the raise, which it was created within (the check
  // above), never to the one read before it. A Restore and a new Archive in between supersede the first read; the card
  // then belongs to the new archive, which the sweep acts on and `probeCardOutcome` checks (r6), so it is tracked and
  // never left pending behind a fallback purge (r13 replaces r12's `probe-card-archive-changed`).
  // Codex PR239-r2: another purge card for this archive raised between the lookup and the raise (and approved, so
  // the pending dedupe missed it) is the one the sweep acts on first; track the oldest.
  return (await d.existing(archived)) ?? card.id;
}

/**
 * DEVOS-254 decision 3: the card cycle's Archive under the probe's KK grant, asked for `teardown.archive` only, so the
 * probe grant is never presented for `teardown.purge` on this path (pre-review 6).
 */
export async function archiveUnderProbeGrant(d: { findGrant(actions: readonly string[]): Promise<string | null>; archive(grantId: string): Promise<void> }): Promise<void> {
  const grant = await d.findGrant(["teardown.archive"]);
  if (!grant) throw new Error("probe-card-no-grant");
  await d.archive(grant);
}

/** Pre-review 5: the card's per-provider counts as one bounded grouped count (never every row). */
export async function probeActiveCounts(db: any, projectId: string, timeoutMs: number): Promise<Record<string, number>> {
  const rows: { provider: unknown; _count: { _all: number } }[] = await db.$transaction((tx: any) => tx.resource.groupBy({
    by: ["provider"], where: { projectId, status: "active" }, _count: { _all: true },
  }), { timeout: timeoutMs, maxWait: timeoutMs });
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.provider)] = r._count._all;
  return out;
}
