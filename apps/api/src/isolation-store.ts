// S4-a2a (docs/modules/S4.md, "S4-a2 split"): the Postgres `IsolationStore` behind S4's afterStack hook
// (`packages/isolation`, hook.ts) and, in S4-a2b, the read side of GET /internal/isolation-state.
// One `isolation_stack` row per (project, env). The stack index, subnet and network name are unique across all stacks
// (S4-a1 pre-review low note): a colliding offset fails here, inside the hook, so Coolify never gets that stack and
// the state document never has to refuse every project because of one bad row.

/** The hook's record (structurally `StackRecord` from @devos/isolation; apps/api does not import that package). */
export interface IsolationStackRecord {
  projectId: string;
  slug: string;
  env: "preview" | "live";
  idx: number;
  network: string;
  subnet: string;
}

/** What the state route reads: exactly the stack identity; egress and tailnet come from approved selections (S4-a2b). */
export interface IsolationStackRow {
  projectId: string;
  slug: string;
  env: "preview" | "live";
  idx: number;
}

/** A refusal with a fixed code; never the driver message (which can echo values). */
export class IsolationStoreError extends Error {
  constructor(public readonly code: "isolation-stack-invalid" | "isolation-index-taken" | "isolation-store-error") {
    super(code);
    this.name = "IsolationStoreError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The derivation of packages/isolation network.ts, checked again so a row can only hold what the hook would derive. */
export function checkStackRecord(r: IsolationStackRecord): void {
  const ok =
    !!r && typeof r === "object" &&
    typeof r.projectId === "string" && UUID_RE.test(r.projectId) &&
    typeof r.slug === "string" && SLUG_RE.test(r.slug) &&
    (r.env === "preview" || r.env === "live") &&
    Number.isInteger(r.idx) && r.idx >= 0 && r.idx <= 1023 &&
    r.network === `devos-p-${r.slug}-${r.env}` &&
    r.subnet === `10.${208 + Math.floor(r.idx / 256)}.${r.idx % 256}.0/24`;
  if (!ok) throw new IsolationStoreError("isolation-stack-invalid");
}

export class PrismaIsolationStore {
  constructor(
    private readonly db: any,
    private readonly timeoutMs: number,
  ) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  /**
   * Records or refreshes a project stack. Re-recording the same stack is a no-op update; a stack whose index, subnet
   * or network another stack holds is refused (`isolation-index-taken`) and nothing changes.
   */
  async recordStack(r: IsolationStackRecord): Promise<void> {
    checkStackRecord(r);
    try {
      await this.tx(async (tx: any) => {
        const where = { projectId_env: { projectId: r.projectId, env: r.env } };
        const data = { slug: r.slug, idx: r.idx, network: r.network, subnet: r.subnet };
        await tx.isolationStack.upsert({ where, update: data, create: { projectId: r.projectId, env: r.env, ...data }, select: { id: true } });
      });
    } catch (e) {
      // P2002 = unique violation (another stack holds the index, subnet or network).
      if ((e as { code?: string })?.code === "P2002") throw new IsolationStoreError("isolation-index-taken");
      throw new IsolationStoreError("isolation-store-error");
    }
  }

  /** Every recorded stack, ordered by index (stable for the state document). */
  async listStacks(): Promise<IsolationStackRow[]> {
    try {
      const rows = await this.tx(async (tx: any) =>
        tx.isolationStack.findMany({ select: { projectId: true, slug: true, env: true, idx: true }, orderBy: { idx: "asc" } }));
      return rows.map((x: any) => ({ projectId: x.projectId, slug: x.slug, env: x.env, idx: x.idx }));
    } catch {
      throw new IsolationStoreError("isolation-store-error");
    }
  }
}
