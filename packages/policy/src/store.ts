// DevOS M1.7: persistence boundary of the policy engine. Every decision runs inside one serialised,
// atomic unit of work (`decide`), so the receipt, the grant use and the budget reservation commit
// together — or not at all — before the caller sees the outcome.
import { randomUUID } from "node:crypto";
import type { ApprovalGrant, BudgetReservationRow, DecisionRow, PolicyMode, PolicyRule, Provider } from "./types.js";

export interface UsageFilter {
  provider?: Provider;
  projectId?: string;
  runId?: string;
  since?: Date;
}

/** Operations available inside the serialised decision transaction. */
export interface PolicyTx {
  head(chain: string): Promise<{ seq: number; hash: string } | null>;
  insertDecision(row: DecisionRow): Promise<void>;
  getGrant(id: string): Promise<ApprovalGrant | null>;
  useGrant(id: string): Promise<void>;
  /**
   * Open reservations (whatever their age) + reconciled actuals created since `since`; released rows
   * count zero.
   */
  usage(filter: UsageFilter): Promise<{ usd: number; tokens: number }>;
  insertReservation(r: Omit<BudgetReservationRow, "id" | "createdAt" | "actualUsd" | "actualTokens" | "status">): Promise<string>;
}

export interface PolicyStore {
  /** Run `fn` atomically and serialised against every other `decide` (one global policy lock). */
  decide<T>(fn: (tx: PolicyTx) => Promise<T>): Promise<T>;
  loadPolicy(): Promise<{ mode: PolicyMode; rules: PolicyRule[] }>;
  insertGrant(grant: Omit<ApprovalGrant, "id" | "uses" | "revokedAt" | "issuedAt"> & { issuedAt?: Date }): Promise<ApprovalGrant>;
  revokeGrant(id: string, at: Date): Promise<boolean>;
  reconcile(id: string, actualUsd: number, actualTokens: number): Promise<void>;
  release(id: string): Promise<void>;
  readChain(chain: string): Promise<DecisionRow[]>;
}

/** Simple FIFO async mutex. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * In-memory store for tests and local tools. Mirrors the database guarantees that matter here:
 * gapless seq + prev_hash per chain, append-only decisions, `uses <= max_uses`, issuer `kk:%`.
 */
export class MemoryPolicyStore implements PolicyStore {
  mode: PolicyMode;
  rules: PolicyRule[];
  decisions: DecisionRow[] = [];
  grants: ApprovalGrant[] = [];
  reservations: BudgetReservationRow[] = [];
  private readonly lock = new Mutex();

  constructor(opts: { mode?: PolicyMode; rules?: PolicyRule[] } = {}) {
    this.mode = opts.mode ?? "observe";
    this.rules = opts.rules ?? [];
  }

  decide<T>(fn: (tx: PolicyTx) => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const snapshot = {
        decisions: [...this.decisions],
        grants: this.grants.map((g) => ({ ...g })),
        reservations: this.reservations.map((r) => ({ ...r })),
      };
      const tx: PolicyTx = {
        head: async (chain) => {
          const last = this.decisions.filter((d) => d.chain === chain).at(-1);
          return last ? { seq: last.seq, hash: last.hash } : null;
        },
        insertDecision: async (row) => {
          const last = this.decisions.filter((d) => d.chain === row.chain).at(-1);
          if (row.seq !== (last?.seq ?? 0) + 1 || row.prevHash !== (last?.hash ?? null)) {
            throw new Error("policy_decision chain: seq or prev_hash mismatch");
          }
          this.decisions.push(structuredClone(row));
        },
        getGrant: async (id) => {
          const g = this.grants.find((x) => x.id === id);
          return g ? { ...g } : null;
        },
        useGrant: async (id) => {
          const g = this.grants.find((x) => x.id === id);
          if (!g || g.uses + 1 > g.maxUses) throw new Error("approval_grant_uses");
          g.uses += 1;
        },
        usage: async (f) => sumUsage(this.reservations, f),
        insertReservation: async (r) => {
          const id = randomUUID();
          this.reservations.push({ ...r, id, actualUsd: null, actualTokens: null, status: "reserved", createdAt: new Date() });
          return id;
        },
      };
      try {
        return await fn(tx);
      } catch (err) {
        this.decisions = snapshot.decisions;
        this.grants = snapshot.grants;
        this.reservations = snapshot.reservations;
        throw err;
      }
    });
  }

  async loadPolicy() {
    return { mode: this.mode, rules: structuredClone(this.rules) };
  }

  insertGrant(g: Omit<ApprovalGrant, "id" | "uses" | "revokedAt" | "issuedAt"> & { issuedAt?: Date }) {
    // Serialised with decide() (PR13-r4): no mutation can interleave with a decision or be undone by its rollback.
    return this.lock.run(async () => {
      const issuedAt = g.issuedAt ?? new Date();
      if (!g.issuedBy.startsWith("kk:")) throw new Error("approval_grant_issuer_is_kk");
      if (!(g.expiresAt > issuedAt)) throw new Error("approval_grant_expiry");
      if (!(g.maxUses >= 1)) throw new Error("approval_grant_uses");
      const grant: ApprovalGrant = { ...g, id: randomUUID(), issuedAt, uses: 0, revokedAt: null };
      this.grants.push(grant);
      return { ...grant };
    });
  }

  revokeGrant(id: string, at: Date) {
    // Serialised with decide() (PR13-r4): no mutation can interleave with a decision or be undone by its rollback.
    return this.lock.run(async () => {
      const g = this.grants.find((x) => x.id === id);
      if (!g || g.revokedAt) return false;
      g.revokedAt = at;
      return true;
    });
  }

  reconcile(id: string, actualUsd: number, actualTokens: number) {
    // Serialised with decide() (PR13-r4): no mutation can interleave with a decision or be undone by its rollback.
    return this.lock.run(async () => {
      const r = this.reservations.find((x) => x.id === id);
      if (!r || r.status !== "reserved") throw new Error("reservation-not-open");
      Object.assign(r, { actualUsd, actualTokens, status: "reconciled" });
    });
  }

  release(id: string) {
    // Serialised with decide() (PR13-r4): no mutation can interleave with a decision or be undone by its rollback.
    return this.lock.run(async () => {
      const r = this.reservations.find((x) => x.id === id);
      if (!r || r.status !== "reserved") throw new Error("reservation-not-open");
      r.status = "released";
    });
  }

  async readChain(chain: string) {
    return structuredClone(this.decisions.filter((d) => d.chain === chain).sort((a, b) => a.seq - b.seq));
  }
}

export function sumUsage(rows: readonly BudgetReservationRow[], f: UsageFilter): { usd: number; tokens: number } {
  let usd = 0;
  let tokens = 0;
  for (const r of rows) {
    if (f.provider && r.provider !== f.provider) continue;
    if (f.projectId && r.projectId !== f.projectId) continue;
    if (f.runId && r.runId !== f.runId) continue;
    // Open reservations always count; only reconciled spend is windowed (PR13-r5).
    if (f.since && r.status !== "reserved" && r.createdAt < f.since) continue;
    if (r.status === "reserved") {
      usd += r.reservedUsd;
      tokens += r.reservedTokens;
    } else if (r.status === "reconciled") {
      usd += r.actualUsd ?? 0;
      tokens += r.actualTokens ?? 0;
    }
  }
  return { usd, tokens };
}
