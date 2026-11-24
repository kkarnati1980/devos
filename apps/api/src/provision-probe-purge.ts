// DEVOS-234 (M2.4-d3c-2a, docs/modules/M2.4.md "M2.4-d3c-2 decisions"): the AT13 probe's purge through M2.5, as any
// project would be purged: Archive, then Purge, on the production ops, scanners and preflight list, under the M1.7
// policy with a KK grant (never `allowAll`, never a delete by name). Output is fixed codes only.
import type { PurgeOutcome } from "./provision-probe.js";
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
