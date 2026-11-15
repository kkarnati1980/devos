// CR-b2b (DEVOS-215, docs/modules/ADR-0012.md "CR-b2b"): the Postgres `QueueStore` for the batched cards (rules 6–10)
// and `BatchCards` over the M2.3 core. The rules live in @devos/card-batch (CR-b2a); this file only stores them.
//
// - Every method but `withBatchLock` is one transaction with a transaction-local `statement_timeout` and Prisma's
//   `timeout`/`maxWait` (ADR-0011 timeouts), like PrismaApprovalStore.
// - `claim` serialises per project on `pg_advisory_xact_lock(hashtext('devos:card-batch-claim'), hashtext(project))`,
//   and `card_batch` is unique on (project_id, ist_day), so two flushes can never claim two batches for one day.
// - `withBatchLock` (rule 8 step 2) takes the session lock `pg_try_advisory_lock(hashtext('devos:card-batch:' ||
//   batchId))` on its own `pg` connection that does nothing else (the M2.4 provision-store pattern), and releases it
//   after `fn`; a holder that crashes drops the connection, which releases the lock.
import pg from "pg";
import type { BatchCards, CardBatch, DecisionRow, QueueStore, QueuedQuestion } from "@devos/card-batch";
import { looksSecret } from "./notify.js";
import type { Approvals } from "./approvals.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaTxLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/** The part of a `pg` client the batch lock needs (a real `pg.Client`, or a stub in tests). */
export interface LockConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  on(event: "error", cb: (e: Error) => void): unknown;
}

export interface CardBatchStoreOptions {
  /** Opens the dedicated lock connection. Default: a new `pg.Client` on `databaseUrl`. */
  connectLock?: () => Promise<LockConnection>;
  databaseUrl?: string;
  /** Bound of every store transaction and of the lock connection's connect and statements (default 10 s). */
  timeoutMs?: number;
}

const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('devos:card-batch:' || $1::text)) AS ok";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('devos:card-batch:' || $1::text)) AS ok";
/** Races `p` against `ms` (client-side bound, as M2.4's `bounded`, Codex PR44-r2): a half-open link cannot hang. */
function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`card-batch-lock-timeout:${what}`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** A list limit as a positive integer at most CARD_BATCH_LIST_MAX (anything else gives the maximum). */
function listLimit(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : CARD_BATCH_LIST_MAX;
  return Math.min(Math.max(1, n), CARD_BATCH_LIST_MAX);
}

/** Batches or projects one sync tick reads (the rest are reached on later ticks; bounded reads, ADR-0011 §9). */
export const CARD_BATCH_LIST_MAX = 100;

function toQuestion(r: any): QueuedQuestion {
  return {
    id: r.id,
    projectId: r.project_id,
    text: r.text,
    source: r.source,
    default: r.default_answer,
    blocks: [...(r.blocks ?? [])],
    queuedAt: r.queued_at,
    batchId: r.batch_id ?? null,
  };
}

function toBatch(r: any): CardBatch {
  return {
    id: r.id,
    projectId: r.project_id,
    istDay: r.ist_day,
    state: r.state,
    cardId: r.card_id ?? null,
    appliedAt: r.applied_at ?? null,
    handedOffAt: r.handed_off_at ?? null,
    settledAt: r.settled_at ?? null,
  };
}

const BATCH_COLS = "id, project_id, ist_day, state, card_id, applied_at, handed_off_at, settled_at";
const QUESTION_COLS = "id, project_id, text, source, default_answer, blocks, queued_at, batch_id";

export class PrismaQueueStore implements QueueStore {
  private readonly timeoutMs: number;

  constructor(private readonly db: PrismaTxLike, private readonly o: CardBatchStoreOptions = {}) {
    this.timeoutMs = o.timeoutMs ?? 10_000;
    if (!o.connectLock && !o.databaseUrl) throw new Error("PrismaQueueStore: connectLock or databaseUrl is required");
  }

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (t: any) => {
        await t.$queryRaw`SELECT set_config('statement_timeout', ${String(this.timeoutMs)}, true) AS statement_timeout`;
        return fn(t);
      },
      { timeout: this.timeoutMs, maxWait: this.timeoutMs },
    );
  }

  projectName(projectId: string) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe("SELECT name FROM project WHERE id = $1::uuid", projectId);
      return rows[0]?.name ?? null;
    });
  }

  queue(q: QueuedQuestion, provisional: DecisionRow) {
    return this.tx(async (tx) => {
      const ins = await tx.$queryRawUnsafe(
        `INSERT INTO queued_question (id, project_id, text, source, default_answer, blocks, queued_at, batch_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid[], $7, NULL) ON CONFLICT (id) DO NOTHING RETURNING id`,
        q.id, q.projectId, q.text, q.source, q.default, q.blocks, q.queuedAt,
      );
      // Rule 7: the provisional row is written with the question, in the same transaction, and only by the call that
      // inserted it, so a retried call writes nothing (CR-b2a).
      if (ins.length === 1) {
        await tx.$queryRawUnsafe(
          `INSERT INTO project_decision (project_id, item_id, text, answer, source, approval_id)
           VALUES ($1::uuid, $2, $3, $4, $5, NULL)`,
          provisional.projectId, provisional.itemId, provisional.text, provisional.answer, provisional.source,
        );
      }
      const rows = await tx.$queryRawUnsafe(`SELECT ${QUESTION_COLS} FROM queued_question WHERE id = $1::uuid`, q.id);
      return toQuestion(rows[0]);
    });
  }

  claim(projectId: string, day: string, newId: string) {
    return this.tx(async (tx) => {
      await tx.$queryRawUnsafe("SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('devos:card-batch-claim'), hashtext($1::text))) AS l", projectId);
      const open = await tx.$queryRawUnsafe(
        `SELECT ${BATCH_COLS} FROM card_batch WHERE project_id = $1::uuid
           AND (state = 'raising' OR (state = 'refused' AND handed_off_at IS NULL))
         ORDER BY created_at, id LIMIT 1`,
        projectId,
      );
      if (open.length) return toBatch(open[0]);
      const waiting = await tx.$queryRawUnsafe("SELECT 1 FROM queued_question WHERE project_id = $1::uuid AND batch_id IS NULL LIMIT 1", projectId);
      if (!waiting.length) return null;
      const made = await tx.$queryRawUnsafe(
        `INSERT INTO card_batch (id, project_id, ist_day, state) VALUES ($1::uuid, $2::uuid, $3, 'raising')
         ON CONFLICT (project_id, ist_day) DO NOTHING RETURNING ${BATCH_COLS}`,
        newId, projectId, day,
      );
      if (!made.length) return null; // the project already had its batch for this IST day
      await tx.$queryRawUnsafe("UPDATE queued_question SET batch_id = $1::uuid WHERE project_id = $2::uuid AND batch_id IS NULL", newId, projectId);
      return toBatch(made[0]);
    });
  }

  batch(id: string) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT ${BATCH_COLS} FROM card_batch WHERE id = $1::uuid`, id);
      return rows.length ? toBatch(rows[0]) : null;
    });
  }

  members(batchId: string) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT ${QUESTION_COLS} FROM queued_question WHERE batch_id = $1::uuid ORDER BY queued_at, id`, batchId);
      return rows.map(toQuestion);
    });
  }

  async markRaised(batchId: string, cardId: string) {
    await this.tx((tx) => tx.$queryRawUnsafe("UPDATE card_batch SET state = 'raised', card_id = $2::uuid WHERE id = $1::uuid AND state = 'raising'", batchId, cardId));
  }

  async markRefused(batchId: string) {
    await this.tx((tx) => tx.$queryRawUnsafe("UPDATE card_batch SET state = 'refused' WHERE id = $1::uuid AND state = 'raising'", batchId));
  }

  async markHandedOff(batchId: string, now: Date) {
    await this.tx((tx) => tx.$queryRawUnsafe("UPDATE card_batch SET handed_off_at = $2 WHERE id = $1::uuid AND state = 'refused' AND handed_off_at IS NULL", batchId, now));
  }

  apply(batchId: string, rows: readonly DecisionRow[], now: Date) {
    return this.tx(async (tx) => {
      // The conditional update decides the one winner (CR-b2a pre-review finding 2); the rows commit with it.
      const won = await tx.$queryRawUnsafe(
        "UPDATE card_batch SET applied_at = $2 WHERE id = $1::uuid AND state = 'raised' AND applied_at IS NULL RETURNING id",
        batchId, now,
      );
      if (!won.length) return false;
      for (const r of rows) {
        await tx.$queryRawUnsafe(
          `INSERT INTO project_decision (project_id, item_id, text, answer, source, approval_id)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid) ON CONFLICT (approval_id, item_id) DO NOTHING`,
          r.projectId, r.itemId, r.text, r.answer, r.source, r.approvalId,
        );
      }
      return true;
    });
  }

  /** Codex PR135-r3: the final rows stored for one card, so a replayed apply returns what the winner recorded. */
  finalRows(approvalId: string) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        "SELECT project_id, item_id, text, answer, source, approval_id FROM project_decision WHERE approval_id = $1::uuid ORDER BY item_id LIMIT 1000",
        approvalId,
      );
      return rows.map((r: any): DecisionRow => ({ projectId: r.project_id, itemId: r.item_id, text: r.text, answer: r.answer, source: r.source, approvalId: r.approval_id }));
    });
  }

  async markSettled(batchId: string, now: Date) {
    await this.tx((tx) => tx.$queryRawUnsafe("UPDATE card_batch SET settled_at = $2 WHERE id = $1::uuid AND applied_at IS NOT NULL AND settled_at IS NULL", batchId, now));
  }

  private async openLock(): Promise<LockConnection> {
    if (this.o.connectLock) {
      const pending = this.o.connectLock();
      // Pre-review CR-b2b r2: a connection that arrives after the bound is ended, never leaked.
      return bounded(pending, this.timeoutMs, "connect").catch((e) => {
        void pending.then((c) => c.end()).catch(() => {});
        throw e;
      });
    }
    const c = new pg.Client({ connectionString: this.o.databaseUrl, connectionTimeoutMillis: this.timeoutMs, statement_timeout: this.timeoutMs, query_timeout: this.timeoutMs });
    c.on("error", () => {});
    try {
      await bounded(c.connect(), this.timeoutMs, "connect");
    } catch (e) {
      void c.end().catch(() => {});
      throw e;
    }
    return c as unknown as LockConnection;
  }

  async withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
    const conn = await this.openLock();
    // An idle connection error (the server went away) must not crash the process; the lock is gone with it. A lock
    // lost while `fn` runs is not detected (pre-review CR-b2b finding 4): the bound is M2.3's pending-twin dedupe
    // and the next flush's lookup by target (contract, CR-b2b runner decisions).
    conn.on("error", () => {});
    const ms = this.timeoutMs;
    try {
      const r = await bounded(conn.query(LOCK_SQL, [batchId]), ms, "lock");
      if (r.rows[0]?.ok !== true) return { locked: false };
      try {
        return { locked: true, value: await fn() };
      } finally {
        await bounded(conn.query(UNLOCK_SQL, [batchId]), ms, "unlock").catch(() => {});
      }
    } finally {
      await bounded(conn.end(), ms, "end").catch(() => {});
    }
  }

  // The sync job's reads (CR-b2d wiring): bounded, oldest first.

  /**
   * Raised batches not yet settled whose card is decided (rule 9; Codex PR135-r1), oldest first. Batches with a
   * pending card are left out, so they cannot fill the window and starve a decided one (pre-review CR-b2b finding 2).
   */
  batchesToApply(limit = CARD_BATCH_LIST_MAX) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT cb.id FROM card_batch cb JOIN approval a ON a.id = cb.card_id
          WHERE cb.state = 'raised' AND cb.settled_at IS NULL AND a.status <> 'pending'
          ORDER BY cb.created_at, cb.id LIMIT $1::int`,
        listLimit(limit),
      );
      return rows.map((r: any) => r.id as string);
    });
  }

  /**
   * Projects a flush on IST day `day` can act on: a question not yet in a batch while the project has no batch for
   * `day` (pre-review CR-b2b finding 6: one waiting for tomorrow takes no slot), or a batch still `raising` or
   * refused and not handed off.
   */
  projectsToFlush(day: string, limit = CARD_BATCH_LIST_MAX) {
    return this.tx(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT project_id FROM (
           SELECT q.project_id, min(q.queued_at) AS since FROM queued_question q
            WHERE q.batch_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM card_batch d WHERE d.project_id = q.project_id AND d.ist_day = $2)
            GROUP BY q.project_id
           UNION ALL
           SELECT project_id, min(created_at) FROM card_batch
            WHERE state = 'raising' OR (state = 'refused' AND handed_off_at IS NULL) GROUP BY project_id
         ) p GROUP BY project_id ORDER BY min(since), project_id LIMIT $1::int`,
        listLimit(limit), day,
      );
      return rows.map((r: any) => r.project_id as string);
    });
  }
}

/** The reads `approvalBatchCards.check` needs: the projects of the named tasks (missing ids are absent). */
export interface TaskProjects {
  taskProjects(ids: readonly string[]): Promise<Map<string, string | null>>;
}

/**
 * `BatchCards` over the M2.3 core: raise through `Approvals.raiseCard` (parse, dedupe, blockers, notify), and read
 * cards through its store (DEVOS-190 target filter). `check` runs at queue time the refusals no retry can change
 * (CR-b2a pre-review finding 1), with the same rules as M2.3: a secret-shaped reason, and blocked tasks that are
 * missing or belong to another project.
 */
export function approvalBatchCards(approvals: Approvals, tasks?: TaskProjects): BatchCards {
  const cards: BatchCards = {
    raiseCard: (input, blocks) => approvals.raiseCard(input, blocks),
    async findByTarget(projectId, target) {
      const page = await approvals.store.list({ projectId, gate: "decision", target, limit: 1 });
      return page[0] ? { id: page[0].id } : null;
    },
    async get(id) {
      const c = await approvals.store.get(id);
      return c ? { id: c.id, status: c.status, decidedAt: c.decidedAt } : null;
    },
    async comments(id) {
      return (await approvals.store.comments(id)).map((c) => ({ body: c.body, createdAt: c.createdAt }));
    },
  };
  if (tasks) {
    cards.check = async ({ projectId, reason, blocks }) => {
      if (looksSecret(reason)) return "card-contains-secret";
      if (!blocks.length) return null;
      const found = await tasks.taskProjects(blocks);
      if (blocks.some((t) => !found.has(t))) return "task-not-found";
      if (blocks.some((t) => found.get(t) !== projectId)) return "task-other-project";
      return null;
    };
  }
  return cards;
}

/** `TaskProjects` over Prisma: one read in a bounded transaction (ADR-0011 timeouts; pre-review CR-b2b finding 3). */
export function prismaTaskProjects(db: PrismaTxLike, timeoutMs = 10_000): TaskProjects {
  return {
    taskProjects(ids) {
      return db.$transaction(
        async (tx: any) => {
          await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout`;
          const rows: { id: string; project_id: string | null }[] = await tx.$queryRawUnsafe(
            "SELECT id, project_id FROM task WHERE id = ANY($1::uuid[])",
            [...new Set(ids)],
          );
          return new Map(rows.map((r) => [r.id, r.project_id]));
        },
        { timeout: timeoutMs, maxWait: timeoutMs },
      );
    },
  };
}
