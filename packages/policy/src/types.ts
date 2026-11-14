// DevOS M1.7 policy engine types (docs/modules/M1.7.md). Shapes follow the ADR-0006 tables in
// packages/db/prisma/schema.prisma; the decision vocabulary is DevOS's own (allow/deny/require_approval).

export type PolicyEffect = "allow" | "deny" | "require_approval";
export type PolicyMode = "observe" | "enforce";
export type IdentityType = "agent" | "kk" | "system";
export type Provider = "anthropic" | "openai";

/** Who asks. KK's id is `kk:<tailscale login>`; agents are `agent:<role>:<run id>`. */
export interface PolicyIdentity {
  id: string;
  type: IdentityType;
  roles?: string[];
}

/** What is asked for. `costUsd`/`tokens` are the reservation the caller declares before the call. */
export interface PolicyAction {
  type: string;
  resource?: string;
  environment?: string;
  tool?: string;
  /** Paths the action reads or writes (repo-relative, no `..`). */
  readPaths?: string[];
  writePaths?: string[];
  network?: boolean;
  host?: string;
  costUsd?: number;
  tokens?: number;
  concurrency?: number;
  /** A metered model call. Budget rules apply and a missing figure is a deny (fail-closed). */
  budgeted?: boolean;
  provider?: Provider;
  projectId?: string;
  runId?: string;
  sha?: string;
}

export interface PolicyEvidence {
  kind: string;
  ref: string;
  provenance: "kk_approved" | "system_observation" | "tool_result" | "agent_output" | "user_claim" | "unknown";
}

export interface PolicyRequest {
  identity: PolicyIdentity;
  action: PolicyAction;
  evidence?: PolicyEvidence[];
  envelope?: CapabilityEnvelope;
  /** ApprovalGrant id the caller presents for a require_approval action. */
  approvalGrantId?: string;
  chain?: string;
}

/** A run's delegated authority (capability_envelope). Lists are allow-lists; empty means none. */
export interface CapabilityEnvelope {
  tools: string[];
  readPaths: string[];
  writePaths: string[];
  network: boolean;
  networkAllowList: string | null;
  maxCostUsd: number;
  maxTokens: number;
  maxConcurrency: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  depth: number;
}

export interface RuleConstraints {
  /** Gate rules (G0–G5, Release SHA checks, migration holds) are enforced in observe mode too. */
  gate?: boolean;
  maxCostUsd?: number;
  maxTokens?: number;
  network?: boolean;
  requiredProvenance?: PolicyEvidence["provenance"][];
  /**
   * DEVOS-134: the M2.3 approval gate a `require_approval` from this rule raises (`requirements`, `decision`,
   * `first_launch`, `destructive_or_spend`, `purge`). The engine never reads it; M2.3's `gateFromRules` validates it
   * against its gate list and ignores anything else, so a typo can only fall back to a `decision` card.
   */
  gateName?: string;
}

/** policy_rule. Empty match lists match anything. */
export interface PolicyRule {
  id: string;
  name: string;
  version: number;
  priority: number;
  actions: string[];
  resources: string[];
  principals: string[];
  roles: string[];
  environments: string[];
  effect: PolicyEffect;
  constraints: RuleConstraints;
  enabled: boolean;
}

/** approval_grant. */
export interface ApprovalGrant {
  id: string;
  approvalId: string | null;
  scopeAction: string;
  scopeResource: string | null;
  projectId: string | null;
  sha: string | null;
  issuedBy: string;
  issuedAt: Date;
  expiresAt: Date;
  maxUses: number;
  uses: number;
  revokedAt: Date | null;
}

/** A ceiling the engine checks before any metered call. Provider caps (O5) are the outer limit. */
export interface BudgetCeiling {
  id: string;
  provider?: Provider;
  projectId?: string;
  runId?: string;
  maxCostUsd: number;
  maxTokens: number;
  /** Rolling window; omit for all-time. */
  periodMs?: number;
}

export interface BudgetReservationRow {
  id: string;
  projectId: string | null;
  runId: string | null;
  provider: Provider;
  reservedUsd: number;
  reservedTokens: number;
  actualUsd: number | null;
  actualTokens: number | null;
  status: "reserved" | "reconciled" | "released";
  createdAt: Date;
}

/** The receipt body stored in policy_decision. `hash` covers every other column. */
export interface DecisionRow {
  chain: string;
  seq: number;
  ts: Date;
  projectId: string | null;
  runId: string | null;
  identity: unknown;
  /** { request: PolicyAction, reason, mode, reservationId } in canonical form. */
  action: unknown;
  outcome: PolicyEffect;
  enforcedOutcome: PolicyEffect;
  matchedRuleIds: string[];
  approvalGrantId: string | null;
  bundleHash: string;
  prevHash: string | null;
  hash: string;
  hmac: string;
}

export interface PolicyDecision {
  /** What the rules say. */
  outcome: PolicyEffect;
  /** What the caller must do (differs from outcome only in observe mode). */
  enforcedOutcome: PolicyEffect;
  /** observe mode recorded a deny or approval requirement it did not enforce. */
  wouldBlock: boolean;
  reason: string;
  mode: PolicyMode;
  matchedRuleIds: string[];
  approvalGrantId: string | null;
  reservationId: string | null;
  /**
   * Set when the caller must stop: the run_error type to record. Never counts as a failed attempt
   * (ADR-0006 guard); M1.5 pauses at the last checkpoint and raises a card.
   */
  stop: "policy_denied" | "budget_exceeded" | null;
  receipt: { chain: string; seq: number; hash: string };
}

export interface LedgerVerification {
  valid: boolean;
  length: number;
  error?: string;
  /** seq of the first row that failed. */
  at?: number;
}
