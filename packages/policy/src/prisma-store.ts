// DevOS M1.7: PolicyStore over the M1.1 Prisma client (@devos/db `createDb`). Typed structurally so
// this package has no runtime dependency on the generated client. One global advisory lock
// serialises every decision; the decision row, grant use and reservation commit in one transaction,
// and the M1.1 triggers still reject a gap, a wrong prev_hash, an update or a delete.
import type { PolicyStore, PolicyTx, UsageFilter } from "./store.js";
import type { ApprovalGrant, DecisionRow, PolicyMode, PolicyRule, Provider, RuleConstraints } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = any;
export interface PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { isolationLevel?: string; timeout?: number; maxWait?: number }): Promise<T>;
  policyState: Delegate;
  policyRule: Delegate;
  policyDecision: Delegate;
  approvalGrant: Delegate;
  budgetReservation: Delegate;
}

/** Key for pg_advisory_xact_lock: hashtext('devos:policy-engine'). */
const LOCK_KEY = "devos:policy-engine";

/** Exact Decimal(12, 6) text; the engine has already rounded up, so any other value is a bug. */
function usd6(v: number): string {
  const text = v.toFixed(6);
  if (Number(text) !== v) throw new Error("budget-amount-not-micro-usd");
  return text;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(String(v)));

function toGrant(g: any): ApprovalGrant {
  return {
    id: g.id,
    approvalId: g.approvalId,
    scopeAction: g.scopeAction,
    scopeResource: g.scopeResource,
    projectId: g.projectId,
    sha: g.sha,
    issuedBy: g.issuedBy,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    maxUses: g.maxUses,
    uses: g.uses,
    revokedAt: g.revokedAt,
  };
}

function toRow(d: any): DecisionRow {
  return {
    chain: d.chain,
    seq: d.seq,
    ts: d.ts,
    projectId: d.projectId,
    runId: d.runId,
    identity: d.identity,
    action: d.action,
    outcome: d.outcome,
    enforcedOutcome: d.enforcedOutcome,
    matchedRuleIds: d.matchedRuleIds,
    approvalGrantId: d.approvalGrantId,
    bundleHash: d.bundleHash,
    prevHash: d.prevHash,
    hash: d.hash,
    hmac: d.hmac,
  };
}

export class PrismaPolicyStore implements PolicyStore {
  constructor(private readonly db: PrismaLike, private readonly timeoutMs = 10_000) {}

  /**
   * Every database call of this store runs here (ADR-0011 timeouts, PR13-r6): the connection wait is
   * bounded by `maxWait`, the whole unit by `timeout`, and each statement by a transaction-local
   * `statement_timeout`, so a stalled database fails the call instead of hanging it.
   */
  private bounded<T>(fn: (t: any) => Promise<T>, lock: boolean): Promise<T> {
    return this.db.$transaction(
      async (t: any) => {
        await t.$queryRaw`SELECT set_config('statement_timeout', ${String(this.timeoutMs)}, true) AS statement_timeout`;
        if (lock) await t.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))) AS l`;
        return fn(t);
      },
      { timeout: this.timeoutMs, maxWait: this.timeoutMs },
    );
  }

  /** Run `fn` in a transaction holding the global policy lock (decisions, reconcile, release, revoke). */
  private locked<T>(fn: (t: any) => Promise<T>): Promise<T> {
    return this.bounded(fn, true);
  }

  decide<T>(fn: (tx: PolicyTx) => Promise<T>): Promise<T> {
    return this.locked(
      async (t: any) => {
        const tx: PolicyTx = {
          head: async (chain) => {
            const last = await t.policyDecision.findFirst({ where: { chain }, orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
            return last ? { seq: last.seq, hash: last.hash } : null;
          },
          insertDecision: async (row) => {
            await t.policyDecision.create({ data: { ...row } });
          },
          getGrant: async (id) => {
            const g = await t.approvalGrant.findUnique({ where: { id } });
            return g ? toGrant(g) : null;
          },
          useGrant: async (id) => {
            await t.approvalGrant.update({ where: { id }, data: { uses: { increment: 1 } } });
          },
          usage: (f) => usageOf(t, f),
          insertReservation: async (r) => {
            const created = await t.budgetReservation.create({
              data: {
                projectId: r.projectId,
                runId: r.runId,
                provider: r.provider,
                reservedUsd: usd6(r.reservedUsd),
                reservedTokens: r.reservedTokens,
              },
              select: { id: true },
            });
            return created.id as string;
          },
        };
        return fn(tx);
      },
    );
  }

  async loadPolicy(): Promise<{ mode: PolicyMode; rules: PolicyRule[] }> {
    const { state, rows } = await this.bounded(async (t) => ({
      state: await t.policyState.findFirst({ where: { singleton: true } }),
      rows: (await t.policyRule.findMany({ where: { enabled: true }, orderBy: [{ name: "asc" }, { version: "desc" }] })) as any[],
    }), false);
    const latest = new Map<string, any>();
    for (const r of rows) if (!latest.has(r.name)) latest.set(r.name, r);
    const rules: PolicyRule[] = [...latest.values()].map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      priority: r.priority,
      actions: r.actions,
      resources: r.resources,
      principals: r.principals,
      roles: r.roles,
      environments: r.environments,
      effect: r.effect,
      constraints: (r.constraints ?? {}) as RuleConstraints,
      enabled: r.enabled,
    }));
    // No state row yet → observe (the M1.1 default); deleting the row is blocked by a trigger.
    return { mode: (state?.mode as PolicyMode | undefined) ?? "observe", rules };
  }

  async insertGrant(g: Omit<ApprovalGrant, "id" | "uses" | "revokedAt" | "issuedAt"> & { issuedAt?: Date }): Promise<ApprovalGrant> {
    return toGrant(await this.bounded((t) => t.approvalGrant.create({ data: { ...g } }), false));
  }

  async revokeGrant(id: string, at: Date): Promise<boolean> {
    const res: { count: number } = await this.locked((t) => t.approvalGrant.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } }));
    return res.count === 1;
  }

  async reconcile(id: string, actualUsd: number, actualTokens: number): Promise<void> {
    // Under the policy lock, so a decision never sees a row move between its usage reads (PR13-r3).
    const res: { count: number } = await this.locked((t) => t.budgetReservation.updateMany({
      where: { id, status: "reserved" },
      data: { status: "reconciled", actualUsd: usd6(actualUsd), actualTokens },
    }));
    if (res.count !== 1) throw new Error("reservation-not-open");
  }

  async release(id: string): Promise<void> {
    const res: { count: number } = await this.locked((t) => t.budgetReservation.updateMany({ where: { id, status: "reserved" }, data: { status: "released" } }));
    if (res.count !== 1) throw new Error("reservation-not-open");
  }

  async readChain(chain: string): Promise<DecisionRow[]> {
    const rows: any[] = await this.bounded((t) => t.policyDecision.findMany({ where: { chain }, orderBy: { seq: "asc" } }), false);
    return rows.map(toRow);
  }
}

async function usageOf(t: any, f: UsageFilter): Promise<{ usd: number; tokens: number }> {
  const where: Record<string, unknown> = {};
  if (f.provider) where.provider = f.provider as Provider;
  if (f.projectId) where.projectId = f.projectId;
  if (f.runId) where.runId = f.runId;
  // Open reservations are outstanding commitments: they count however old they are (PR13-r5).
  // Only reconciled spend is windowed by the rolling period.
  const open = await t.budgetReservation.aggregate({ where: { ...where, status: "reserved" }, _sum: { reservedUsd: true, reservedTokens: true } });
  const doneWhere = f.since ? { ...where, status: "reconciled", createdAt: { gte: f.since } } : { ...where, status: "reconciled" };
  const done = await t.budgetReservation.aggregate({ where: doneWhere, _sum: { actualUsd: true, actualTokens: true } });
  return {
    usd: num(open._sum.reservedUsd) + num(done._sum.actualUsd),
    tokens: num(open._sum.reservedTokens) + num(done._sum.actualTokens),
  };
}
