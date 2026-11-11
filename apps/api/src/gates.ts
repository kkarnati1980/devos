// M2.3 gate engine (docs/modules/M2.3.md, D10): a milestone closes only with an approved approval of the same project
// whose gate equals the milestone's gate name, and only after M1.7 `decide` allows the `gate.transition`.
// The M1.1 AT18 trigger (milestone_gate_approved) is the database backstop; this gives the friendly error first.
import { ApprovalError, type AuditEntry, type CardStatus } from "./approvals.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MilestoneRow {
  id: string;
  projectId: string;
  gateName: string;
  closedAt: Date | null;
}

export interface GateApprovalRow {
  id: string;
  projectId: string | null;
  gate: string;
  status: CardStatus;
}

export interface GateStore {
  milestone(id: string): Promise<MilestoneRow | null>;
  approval(id: string): Promise<GateApprovalRow | null>;
  /** Closes the milestone with its gate approval and audits, in one transaction; false if it was already closed. */
  close(milestoneId: string, approvalId: string, at: Date, audit: AuditEntry, actor: "agent" | "kk" | "system"): Promise<boolean>;
}

/** The M1.7 surface the gate engine needs (structural; `@devos/policy` PolicyEngine.decide). */
export interface GatePolicy {
  decide(request: {
    identity: { id: string; type: "agent" | "kk" | "system"; roles?: string[] };
    action: { type: string; resource?: string; projectId?: string };
  }): Promise<{ enforcedOutcome: "allow" | "deny" | "require_approval"; reason: string }>;
}

export class GateEngine {
  constructor(
    private readonly deps: { store: GateStore; policy: GatePolicy; now?: () => number },
  ) {}

  /**
   * D10: close a milestone with gate evidence. Refuses with `gate-evidence-missing` (409) unless the approval is
   * approved, belongs to the milestone's project and its gate equals the milestone's gate name; a policy deny or
   * approval requirement stops it with the policy reason code (403).
   */
  async closeMilestone(
    identity: { id: string; type: "agent" | "kk" | "system"; roles?: string[] },
    milestoneId: string,
    approvalId: string,
  ): Promise<{ milestoneId: string; approvalId: string; closedAt: Date }> {
    if (!UUID.test(milestoneId) || !UUID.test(approvalId)) throw new ApprovalError("invalid-input");
    const m = await this.deps.store.milestone(milestoneId);
    if (!m) throw new ApprovalError("milestone-not-found", 404);
    if (m.closedAt) throw new ApprovalError("milestone-closed", 409);
    const a = await this.deps.store.approval(approvalId);
    if (!a || a.status !== "approved" || a.projectId !== m.projectId || a.gate !== m.gateName) {
      throw new ApprovalError("gate-evidence-missing", 409);
    }
    const decision = await this.deps.policy.decide({
      identity,
      action: { type: "gate.transition", resource: `milestone:${m.id}`, projectId: m.projectId },
    });
    if (decision.enforcedOutcome !== "allow") throw new ApprovalError(policyCode(decision.reason), 403);
    const at = new Date((this.deps.now ?? Date.now)());
    const ok = await this.deps.store.close(m.id, a.id, at, {
      action: "milestone.closed",
      summary: `Milestone closed through gate ${m.gateName}`,
      details: { milestoneId: m.id, approvalId: a.id, gate: m.gateName },
    }, identity.type);
    if (!ok) throw new ApprovalError("milestone-closed", 409);
    return { milestoneId: m.id, approvalId: a.id, closedAt: at };
  }
}

/** The first reason code of a policy decision, reduced to a fixed-code shape (never free text). */
function policyCode(reason: string): string {
  const first = ((reason || "").split(";")[0] ?? "").trim();
  return /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(first) ? first : "policy-denied";
}

export class MemoryGateStore implements GateStore {
  readonly milestones = new Map<string, MilestoneRow>();
  readonly approvals = new Map<string, GateApprovalRow>();
  readonly audit: AuditEntry[] = [];

  async milestone(id: string) {
    const m = this.milestones.get(id);
    return m ? { ...m } : null;
  }
  async approval(id: string) {
    const a = this.approvals.get(id);
    return a ? { ...a } : null;
  }
  async close(milestoneId: string, _approvalId: string, at: Date, audit: AuditEntry, _actor: "agent" | "kk" | "system") {
    const m = this.milestones.get(milestoneId);
    if (!m || m.closedAt) return false;
    m.closedAt = at;
    this.audit.push(audit);
    return true;
  }
}

/** Postgres gate store; each call is one bounded transaction (ADR-0011 timeouts). */
export class PrismaGateStore implements GateStore {
  constructor(
    private readonly db: { $transaction<T>(fn: (tx: any) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T> },
    private readonly timeoutMs = 10_000,
  ) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (t: any) => {
        await t.$queryRaw`SELECT set_config('statement_timeout', ${String(this.timeoutMs)}, true) AS statement_timeout`;
        return fn(t);
      },
      { timeout: this.timeoutMs, maxWait: this.timeoutMs },
    );
  }

  milestone(id: string) {
    return this.tx(async (tx) => {
      const m = await tx.milestone.findUnique({ where: { id }, select: { id: true, projectId: true, gateName: true, closedAt: true } });
      return m ? { id: m.id, projectId: m.projectId, gateName: m.gateName, closedAt: m.closedAt ?? null } : null;
    });
  }

  approval(id: string) {
    return this.tx(async (tx) => {
      const a = await tx.approval.findUnique({ where: { id }, select: { id: true, projectId: true, gate: true, status: true } });
      return a ? { id: a.id, projectId: a.projectId ?? null, gate: a.gate, status: a.status } : null;
    });
  }

  close(milestoneId: string, approvalId: string, at: Date, audit: AuditEntry, actor: "agent" | "kk" | "system") {
    return this.tx(async (tx) => {
      // The milestone_gate_approved trigger re-checks the approval under its row lock (backstop).
      const r = await tx.milestone.updateMany({ where: { id: milestoneId, closedAt: null }, data: { closedAt: at, gateApprovalId: approvalId } });
      if (r.count !== 1) return false;
      const m = await tx.milestone.findUnique({ where: { id: milestoneId }, select: { projectId: true } });
      await tx.auditEvent.create({
        data: { actor, action: audit.action, summary: audit.summary, details: audit.details, projectId: m?.projectId ?? null },
      });
      return true;
    });
  }
}
