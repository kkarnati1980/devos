// Adapted from ruflo (https://github.com/ruvnet/ruflo), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64,
// file v3/@claude-flow/security/src/policy/engine.ts (evaluate, applyApproval, applyBudget,
// issueApproval, revokeApproval). MIT License, Copyright (c) 2024-2026 ruvnet.
// Full licence text: THIRD_PARTY_NOTICES.md at the repository root.
// DevOS changes (M1.7): state lives in Postgres behind PolicyStore, not an in-process object; the
// receipt, grant use and budget reservation commit in one serialised transaction BEFORE `decide`
// resolves; budgets reserve before the call and reconcile after; only a verified KK dashboard
// session issues or revokes grants; budget and envelope stops are enforced in observe mode.
import { sha256Hex } from "./canonical.js";
import { evaluateRules, wildcard } from "./evaluator.js";
import { sealRow } from "./receipts.js";
import type { PolicyStore } from "./store.js";
import type {
  ApprovalGrant,
  BudgetCeiling,
  LedgerVerification,
  PolicyDecision,
  PolicyEffect,
  PolicyIdentity,
  PolicyRequest,
  PolicyRule,
} from "./types.js";
import { verifyLedger } from "./receipts.js";

/** Longest life of an approval grant (rules.md: waivers ≤ 90 days). */
export const MAX_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
export const MIN_HMAC_KEY_BYTES = 32;

/**
 * USD amounts are stored as Decimal(12, 6). Round UP to the micro-dollar so what is checked equals
 * what is stored and rounding can never undercount spend (PR13-r1).
 */
export function ceilMicroUsd(usd: number): number {
  return Math.ceil(Number((usd * 1e6).toFixed(3))) / 1e6;
}
const micros = (usd: number): number => Math.round(usd * 1e6);
/** A ceiling rounds DOWN to the micro-dollar (never grants more than configured). */
const ceilingMicros = (usd: number): number => Math.floor(Number((usd * 1e6).toFixed(3)));

/** The dashboard session presenting KK's Tailscale identity (O4). Verified by the caller's hook. */
export interface KkSession {
  identity: PolicyIdentity;
  /** Opaque session evidence (e.g. the Tailscale-User-Login header the API already checked). */
  tailscaleLogin: string;
}

export interface GrantScope {
  approvalId?: string | null;
  scopeAction: string;
  scopeResource?: string | null;
  projectId?: string | null;
  sha?: string | null;
  expiresAt: Date;
  maxUses?: number;
}

export interface PolicyEngineOptions {
  store: PolicyStore;
  /** Receipt HMAC key, from the server vault / env (never the repo). At least 32 bytes. */
  hmacKey: Buffer;
  budgets?: BudgetCeiling[];
  now?: () => number;
  /** True only for KK's authenticated dashboard session. Absent → no one can issue grants. */
  verifyKkSession?: (session: KkSession) => boolean;
}

export function bundleHashOf(mode: string, rules: readonly PolicyRule[]): string {
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex({ mode, rules: sorted });
}

/** Why a presented grant cannot be used, or null if it can. */
export function grantProblem(grant: ApprovalGrant | null, request: PolicyRequest, now: number): string | null {
  if (!grant) return "grant-not-found";
  if (!grant.issuedBy.startsWith("kk:")) return "grant-issuer-not-kk";
  if (grant.issuedBy === request.identity.id) return "grant-self-approval";
  if (grant.revokedAt) return "grant-revoked";
  if (!(grant.expiresAt.getTime() > now)) return "grant-expired";
  if (!(grant.uses < grant.maxUses)) return "grant-used-up";
  const a = request.action;
  if (!wildcard([grant.scopeAction], a.type)) return "grant-scope-action";
  if (grant.scopeResource !== null && !wildcard([grant.scopeResource], a.resource)) return "grant-scope-resource";
  if (grant.projectId !== null && grant.projectId !== a.projectId) return "grant-scope-project";
  if (grant.sha !== null && grant.sha !== a.sha) return "grant-scope-sha";
  return null;
}

function validateRequest(request: PolicyRequest): void {
  const { identity, action } = request;
  if (!identity?.id || !identity.type || !action?.type) throw new Error("invalid-policy-request");
  if (!["agent", "kk", "system"].includes(identity.type)) throw new Error("invalid-policy-identity");
  for (const [name, value] of [
    ["costUsd", action.costUsd],
    ["tokens", action.tokens],
    ["concurrency", action.concurrency],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new Error(`invalid-policy-action-${name}`);
    }
    if (value !== undefined && name !== "costUsd" && !Number.isSafeInteger(value)) {
      throw new Error(`invalid-policy-action-${name}`);
    }
  }
}

export class PolicyEngine {
  private readonly store: PolicyStore;
  private readonly key: Buffer;
  private readonly budgets: BudgetCeiling[];
  private readonly now: () => number;
  private readonly verifyKkSession?: (session: KkSession) => boolean;

  constructor(options: PolicyEngineOptions) {
    if (!Buffer.isBuffer(options.hmacKey) || options.hmacKey.length < MIN_HMAC_KEY_BYTES) {
      throw new Error("policy-hmac-key-too-short");
    }
    for (const b of options.budgets ?? []) {
      if (![b.maxCostUsd, b.maxTokens].every((v) => Number.isFinite(v) && v >= 0)) throw new Error("invalid-budget-ceiling");
      if (b.periodMs !== undefined && !(b.periodMs > 0)) throw new Error("invalid-budget-period");
    }
    this.store = options.store;
    this.key = Buffer.from(options.hmacKey);
    this.budgets = [...(options.budgets ?? [])];
    this.now = options.now ?? Date.now;
    this.verifyKkSession = options.verifyKkSession;
  }

  /**
   * Evaluate and persist. Resolves only after the receipt has committed; if persistence fails the
   * promise rejects and the caller must treat the action as denied (fail-closed).
   */
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    validateRequest(request);
    const { mode, rules } = await this.store.loadPolicy();
    const bundleHash = bundleHashOf(mode, rules);
    const chain = request.chain ?? "main";

    return this.store.decide(async (tx) => {
      const nowMs = this.now();
      const ev = evaluateRules(request, rules, mode, nowMs);
      let outcome: PolicyEffect = ev.outcome;
      let enforced: PolicyEffect = ev.enforcedOutcome;
      let reason = ev.reason;
      let stop: PolicyDecision["stop"] = null;
      let grantId: string | null = null;
      let reservationId: string | null = null;

      // Approval lifts only a require_approval requirement, never a deny (AT1). In observe mode a
      // gate approval can bind while a non-gate deny is merely recorded: the grant then lifts the
      // enforced requirement and the outcome stays a recorded would-deny.
      const needsApproval = outcome === "require_approval" || enforced === "require_approval";
      if (needsApproval && enforced !== "deny" && request.approvalGrantId) {
        const grant = await tx.getGrant(request.approvalGrantId);
        const problem = grantProblem(grant, request, nowMs);
        if (problem) {
          reason = `${reason};${problem}`;
        } else {
          if (outcome === "require_approval") outcome = "allow";
          enforced = "allow";
          reason = outcome === "allow" ? `approved-by:${grant!.id}` : `${reason};approved-by:${grant!.id}`;
          grantId = grant!.id;
        }
      }

      // Budgets: fail-closed and enforced in every mode; reserve before the call (ADR-0006 §4).
      const a = request.action;
      if (enforced === "allow" && a.budgeted) {
        const budgetDeny = (why: string) => {
          outcome = "deny";
          enforced = "deny";
          reason = why;
          stop = "budget_exceeded";
          grantId = null;
        };
        if (a.costUsd === undefined || a.tokens === undefined) {
          budgetDeny(`budget-metering-required:${a.costUsd === undefined ? "costUsd" : "tokens"}`);
        } else if (!a.provider) {
          budgetDeny("budget-provider-required");
        } else {
          const costUsd = ceilMicroUsd(a.costUsd);
          for (const c of this.budgets) {
            if (c.provider && c.provider !== a.provider) continue;
            if (c.projectId && c.projectId !== a.projectId) continue;
            if (c.runId && c.runId !== a.runId) continue;
            const used = await tx.usage({
              provider: c.provider,
              projectId: c.projectId,
              runId: c.runId,
              since: c.periodMs ? new Date(nowMs - c.periodMs) : undefined,
            });
            if (micros(used.usd) + micros(costUsd) > ceilingMicros(c.maxCostUsd) || used.tokens + a.tokens > c.maxTokens) {
              budgetDeny(`budget-exceeded:${c.id}`);
              break;
            }
          }
          if (enforced === "allow") {
            reservationId = await tx.insertReservation({
              projectId: a.projectId ?? null,
              runId: a.runId ?? null,
              provider: a.provider,
              reservedUsd: costUsd,
              reservedTokens: a.tokens,
            });
          }
        }
      }
      if (grantId) await tx.useGrant(grantId);
      if (enforced === "deny" && stop === null) stop = "policy_denied";

      const head = await tx.head(chain);
      const row = sealRow(
        {
          chain,
          seq: (head?.seq ?? 0) + 1,
          ts: new Date(nowMs),
          projectId: a.projectId ?? null,
          runId: a.runId ?? null,
          identity: request.identity,
          action: { request: a, evidence: request.evidence ?? [], reason, mode, reservationId },
          outcome,
          enforcedOutcome: enforced,
          matchedRuleIds: ev.matchedRuleIds,
          approvalGrantId: grantId,
          bundleHash,
          prevHash: head?.hash ?? null,
        },
        this.key,
      );
      await tx.insertDecision(row);

      return {
        outcome,
        enforcedOutcome: enforced,
        wouldBlock: outcome !== "allow" && enforced === "allow",
        reason,
        mode,
        matchedRuleIds: ev.matchedRuleIds,
        approvalGrantId: grantId,
        reservationId,
        stop: enforced === "allow" ? null : stop,
        receipt: { chain, seq: row.seq, hash: row.hash },
      } satisfies PolicyDecision;
    });
  }

  private requireKk(session: KkSession): string {
    if (session?.identity?.type !== "kk" || !session.identity.id.startsWith("kk:")) throw new Error("grant-issuer-not-kk");
    if (this.verifyKkSession?.(session) !== true) throw new Error("grant-issuer-session-unverified");
    return session.identity.id;
  }

  /** KK issues a scoped, expiring, limited-use grant from the dashboard. */
  async issueGrant(session: KkSession, scope: GrantScope): Promise<ApprovalGrant> {
    const issuedBy = this.requireKk(session);
    const issuedAt = new Date(this.now());
    const maxUses = scope.maxUses ?? 1;
    if (!scope.scopeAction) throw new Error("grant-scope-action-required");
    if (!Number.isInteger(maxUses) || maxUses < 1) throw new Error("grant-max-uses-invalid");
    const life = scope.expiresAt.getTime() - issuedAt.getTime();
    if (!(life > 0) || life > MAX_GRANT_MS) throw new Error("grant-expiry-invalid");
    if (scope.sha != null && !/^[0-9a-f]{40}$/.test(scope.sha)) throw new Error("grant-sha-invalid");
    return this.store.insertGrant({
      approvalId: scope.approvalId ?? null,
      scopeAction: scope.scopeAction,
      scopeResource: scope.scopeResource ?? null,
      projectId: scope.projectId ?? null,
      sha: scope.sha ?? null,
      issuedBy,
      issuedAt,
      expiresAt: scope.expiresAt,
      maxUses,
    });
  }

  async revokeGrant(session: KkSession, grantId: string): Promise<boolean> {
    this.requireKk(session);
    return this.store.revokeGrant(grantId, new Date(this.now()));
  }

  /** After the call: record what it really cost. */
  async reconcile(reservationId: string, actualUsd: number, actualTokens: number): Promise<void> {
    if (![actualUsd, actualTokens].every((v) => Number.isFinite(v) && v >= 0)) throw new Error("invalid-budget-actuals");
    if (!Number.isSafeInteger(actualTokens)) throw new Error("invalid-budget-actuals");
    await this.store.reconcile(reservationId, ceilMicroUsd(actualUsd), actualTokens);
  }

  /** The call never happened: free the reservation. */
  async release(reservationId: string): Promise<void> {
    await this.store.release(reservationId);
  }

  async verify(chain = "main"): Promise<LedgerVerification> {
    return verifyLedger(await this.store.readChain(chain), this.key);
  }
}
