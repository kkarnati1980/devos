// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md rules 6–10, "CR-b split"): the Postgres QueueStore for the batched
// mid-build questions. Every method is one bounded transaction (ADR-0011 §9: `timeout`, `maxWait` and a
// transaction-local `statement_timeout`). The raise step's lock is a **session** advisory lock taken with
// `pg_try_advisory_lock` on one dedicated connection that does nothing else (the M2.4 step-runner pattern): it spans
// M2.3's own transactions, and a holder that crashes drops the connection, which releases it.
import type { CardBatch, DecisionRow, QueueStore, QueuedQuestion } from "@devos/card-batch";

/** The part of a pg client the lock needs (a real `pg.Client`, or a stub in tests). */
export interface LockConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows?: { locked?: boolean }[] } | unknown>;
  end(): Promise<void>;
  on(event: "error", cb: (e: Error) => void): unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tx = any;
export interface CardBatchDb {
  $transaction<T>(fn: (tx: Tx) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T>;
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what}_timeout`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('devos:card-batch:' || $1)) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('devos:card-batch:' || $1)) AS unlocked";

function toBatch(r: any): CardBatch {
  return { id: r.id, projectId: r.projectId, istDay: r.istDay, state: r.state, cardId: r.cardId ?? null, appliedAt: r.appliedAt ?? null, handedOffAt: r.handedOffAt ?? null };
}
function toQuestion(r: any): QueuedQuestion {
  return { id: r.id, projectId: r.projectId, text: r.text, source: r.source, default: r.default, blocks: [...(r.blocks ?? [])], queuedAt: r.queuedAt, batchId: r.batchId ?? null };
}

export class PrismaQueueStore implements QueueStore {
  constructor(
    private readonly db: CardBatchDb,
    private readonly connectLock: () => Promise<LockConnection>,
    private readonly timeoutMs: number,
  ) {}

  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const t = this.timeoutMs;
    return this.db.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(t)}, true) AS statement_timeout`;
      return fn(tx);
    }, { timeout: t, maxWait: t });
  }

  async projectName(projectId: string) {
    return this.tx(async (tx) => ((await tx.project.findUnique({ where: { id: projectId }, select: { name: true } })) as { name: string } | null)?.name ?? null);
  }

  async queue(q: QueuedQuestion, provisional: DecisionRow) {
    return this.tx(async (tx) => {
      // Insert-if-absent on the id (a retried call is safe); the provisional row only with a new question.
      const created = (await tx.$executeRaw`
        INSERT INTO "queued_question" ("id", "project_id", "text", "source", "default", "blocks", "queued_at")
        VALUES (${q.id}::uuid, ${q.projectId}::uuid, ${q.text}, ${q.source}, ${q.default}, ${q.blocks}::uuid[], ${q.queuedAt})
        ON CONFLICT ("id") DO NOTHING`) as number;
      if (created === 1) {
        await tx.projectDecision.create({ data: { projectId: provisional.projectId, itemId: provisional.itemId, text: provisional.text, answer: provisional.answer, source: provisional.source, approvalId: provisional.approvalId } });
      }
      return toQuestion(await tx.queuedQuestion.findUniqueOrThrow({ where: { id: q.id } }));
    });
  }

  async claim(projectId: string, day: string, newId: string) {
    return this.tx(async (tx) => {
      // The project row lock serialises claims for one project (two flushes never both claim, or split members).
      await tx.$queryRaw`SELECT 1 AS locked FROM "project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
      const open = await tx.cardBatch.findFirst({
        where: { projectId, OR: [{ state: "raising" }, { state: "refused", handedOffAt: null }] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (open) return toBatch(open);
      const waiting = await tx.queuedQuestion.count({ where: { projectId, batchId: null } });
      if (waiting === 0) return null;
      if (await tx.cardBatch.findUnique({ where: { projectId_istDay: { projectId, istDay: day } } })) return null;
      const b = await tx.cardBatch.create({ data: { id: newId, projectId, istDay: day, state: "raising" } });
      await tx.queuedQuestion.updateMany({ where: { projectId, batchId: null }, data: { batchId: newId } });
      return toBatch(b);
    });
  }

  async batch(id: string) {
    return this.tx(async (tx) => {
      const r = await tx.cardBatch.findUnique({ where: { id } });
      return r ? toBatch(r) : null;
    });
  }

  async members(batchId: string) {
    return this.tx(async (tx) => (await tx.queuedQuestion.findMany({ where: { batchId }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }] })).map(toQuestion));
  }

  async markRaised(batchId: string, cardId: string) {
    await this.tx((tx) => tx.cardBatch.updateMany({ where: { id: batchId, state: "raising" }, data: { state: "raised", cardId } }));
  }

  async markRefused(batchId: string) {
    await this.tx((tx) => tx.cardBatch.updateMany({ where: { id: batchId, state: "raising" }, data: { state: "refused" } }));
  }

  async markHandedOff(batchId: string, now: Date) {
    await this.tx((tx) => tx.cardBatch.updateMany({ where: { id: batchId, state: "refused", handedOffAt: null }, data: { handedOffAt: now } }));
  }

  async apply(batchId: string, rows: readonly DecisionRow[], now: Date) {
    return this.tx(async (tx) => {
      // Conditional update first: only the call that sets applied_at writes the rows, so two applies have one winner.
      const won = (await tx.cardBatch.updateMany({ where: { id: batchId, appliedAt: null }, data: { appliedAt: now } })) as { count: number };
      if (won.count !== 1) return false;
      if (rows.length > 0) {
        await tx.projectDecision.createMany({
          data: rows.map((r) => ({ projectId: r.projectId, itemId: r.itemId, text: r.text, answer: r.answer, source: r.source, approvalId: r.approvalId })),
          skipDuplicates: true,
        });
      }
      return true;
    });
  }

  /** BatchLister: projects with a waiting question, a `raising` batch or a refused batch not handed off. */
  async projectsToFlush(limit: number): Promise<string[]> {
    return this.tx(async (tx) => {
      const rows = (await tx.$queryRaw`
        SELECT DISTINCT "project_id" AS id FROM (
          SELECT "project_id" FROM "queued_question" WHERE "batch_id" IS NULL
          UNION ALL
          SELECT "project_id" FROM "card_batch" WHERE "state" = 'raising' OR ("state" = 'refused' AND "handed_off_at" IS NULL)
        ) AS w ORDER BY id LIMIT ${limit}`) as { id: string }[];
      return rows.map((r) => r.id);
    });
  }

  /** BatchLister: `raised` batches not applied whose card is no longer pending. */
  async batchesToApply(limit: number): Promise<string[]> {
    return this.tx(async (tx) => {
      const rows = (await tx.$queryRaw`
        SELECT b."id" AS id FROM "card_batch" b JOIN "approval" a ON a."id" = b."card_id"
        WHERE b."state" = 'raised' AND b."applied_at" IS NULL AND a."status" <> 'pending'
        ORDER BY b."created_at", b."id" LIMIT ${limit}`) as { id: string }[];
      return rows.map((r) => r.id);
    });
  }

  async withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
    const ms = this.timeoutMs;
    const conn = await bounded(this.connectLock(), ms, "card_batch_lock_connect");
    conn.on("error", () => {});
    try {
      const res = (await bounded(conn.query(LOCK_SQL, [batchId]), ms, "card_batch_lock")) as { rows?: { locked?: boolean }[] };
      if (res?.rows?.[0]?.locked !== true) return { locked: false };
      try {
        return { locked: true, value: await fn() };
      } finally {
        await bounded(conn.query(UNLOCK_SQL, [batchId]), ms, "card_batch_unlock").catch(() => {});
      }
    } finally {
      // Closing the session also releases the lock. Bounded: a stalled end never holds the flush.
      await bounded(conn.end(), ms, "card_batch_lock_end").catch(() => {});
    }
  }
}
