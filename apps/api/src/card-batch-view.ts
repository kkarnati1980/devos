// ADR-0012 CR-b2c (DEVOS-216): the read-only "Build questions" view of the project page — a project's recent batch
// cards with every question (not only the 2,000-character card reason), each answer recorded with the card, and the
// tasks a rejected or expired card stopped. GET never writes (ADR-0011 §1); questions are data, shown escaped.

/** How many batch cards the page lists (newest IST day first). */
export const BATCH_VIEW_DAYS = 14;
/** Upper bounds per read, so one project can never make the page unbounded. */
export const BATCH_VIEW_QUESTIONS_MAX = 2000;
export const BATCH_VIEW_WAITING_MAX = 200;
export const BATCH_VIEW_TASKS_MAX = 500;

export type CardStatus = "pending" | "approved" | "rejected" | "expired";

export interface BatchQuestionView {
  /** `BQ-<n>`: the number KK answers on the card (members in queue order, as `batchLines` numbers them). */
  ref: string;
  text: string;
  source: string;
  default: string;
  /** The answer recorded with the card (rule 9), or null before it is applied. */
  answer: string | null;
  /** `kk` (KK's `BQ-<n>:` line) or `default`; null before it is applied. */
  answerSource: string | null;
}

export interface StoppedTaskView {
  id: string;
  title: string;
}

export interface BatchView {
  id: string;
  istDay: string;
  /** card_batch.state: `raising` (card not yet raised), `raised` or `refused` (M2.3 refused the card). */
  state: string;
  cardId: string | null;
  /** The M2.3 card's status, or null when no card was raised. */
  cardStatus: CardStatus | null;
  applied: boolean;
  handedOff: boolean;
  questions: BatchQuestionView[];
  /** Rule 10: tasks still blocked by a rejected or expired card ([] otherwise). */
  stoppedTasks: StoppedTaskView[];
}

export interface BatchesView {
  /** Questions queued since the last flush; they join the next daily card. */
  waiting: { text: string; source: string; default: string; queuedAt: string }[];
  /** How many questions wait in all (`waiting` lists at most BATCH_VIEW_WAITING_MAX). */
  waitingCount: number;
  batches: BatchView[];
  /** True when the members read hit BATCH_VIEW_QUESTIONS_MAX: the oldest listed batches may be incomplete. */
  truncated: boolean;
}

export interface BatchRow {
  id: string;
  istDay: string;
  state: string;
  cardId: string | null;
  cardStatus: CardStatus | null;
  applied: boolean;
  handedOff: boolean;
}

export interface BatchQuestionRow {
  id: string;
  batchId: string | null;
  text: string;
  source: string;
  default: string;
  queuedAt: string;
}

export interface BatchViewSnapshot {
  batches: BatchRow[];
  /** Members of the listed batches plus waiting questions (batchId null), each in queue order. */
  questions: BatchQuestionRow[];
  /** Rows recorded with the listed cards: item `Q-<question id>`. */
  decisions: { approvalId: string; itemId: string; answer: string; source: string }[];
  /** Tasks still `blocked` by a listed rejected or expired card. */
  stopped: { approvalId: string; id: string; title: string }[];
  waitingCount: number;
  truncated: boolean;
}

export interface BatchViewReader {
  projectBySlug(slug: string): Promise<{ id: string } | null>;
  /** One consistent read of everything the section shows. */
  batchSnapshot(projectId: string): Promise<BatchViewSnapshot>;
}

/** CR-b2c: the project page's batch view, or null when the slug names no project. */
export async function batchesView(slug: string, reader: BatchViewReader): Promise<BatchesView | null> {
  const project = await reader.projectBySlug(slug);
  if (!project) return null;
  const snap = await reader.batchSnapshot(project.id);
  const answers = new Map<string, { answer: string; source: string }>();
  for (const d of snap.decisions) answers.set(`${d.approvalId} ${d.itemId}`, { answer: d.answer, source: d.source });
  const members = new Map<string, BatchQuestionRow[]>();
  const waiting: BatchesView["waiting"] = [];
  for (const q of snap.questions) {
    if (q.batchId === null) {
      waiting.push({ text: q.text, source: q.source, default: q.default, queuedAt: q.queuedAt });
      continue;
    }
    const list = members.get(q.batchId) ?? [];
    list.push(q);
    members.set(q.batchId, list);
  }
  const batches = snap.batches.map((b): BatchView => {
    const stopsTasks = b.cardStatus === "rejected" || b.cardStatus === "expired";
    return {
      ...b,
      questions: (members.get(b.id) ?? []).map((q, i) => {
        const a = b.cardId ? answers.get(`${b.cardId} Q-${q.id}`) : undefined;
        return { ref: `BQ-${i + 1}`, text: q.text, source: q.source, default: q.default, answer: a?.answer ?? null, answerSource: a?.source ?? null };
      }),
      stoppedTasks: stopsTasks ? snap.stopped.filter((t) => t.approvalId === b.cardId).map((t) => ({ id: t.id, title: t.title })) : [],
    };
  });
  return { waiting, waitingCount: Math.max(snap.waitingCount, waiting.length), batches, truncated: snap.truncated };
}

export interface PrismaViewTxLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, opts?: { timeout?: number; maxWait?: number; isolationLevel?: any }): Promise<T>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** The Postgres reader: one REPEATABLE READ transaction, bounded by a statement timeout and row limits. */
export class PrismaBatchViewStore implements Pick<BatchViewReader, "batchSnapshot"> {
  constructor(private readonly db: PrismaViewTxLike, private readonly timeoutMs = 10_000) {}

  batchSnapshot(projectId: string): Promise<BatchViewSnapshot> {
    return this.db.$transaction(
      async (tx: any) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(this.timeoutMs)}, true) AS statement_timeout`;
        const b: any[] = await tx.$queryRawUnsafe(
          `SELECT b.id, b.ist_day, b.state, b.card_id, a.status::text AS card_status,
                  (b.applied_at IS NOT NULL) AS applied, (b.handed_off_at IS NOT NULL) AS handed_off
             FROM card_batch b LEFT JOIN approval a ON a.id = b.card_id
            WHERE b.project_id = $1::uuid
            ORDER BY b.ist_day DESC, b.created_at DESC, b.id LIMIT $2`,
          projectId, BATCH_VIEW_DAYS,
        );
        const batchIds = b.map((r) => r.id);
        const cardIds = b.map((r) => r.card_id).filter((v): v is string => typeof v === "string");
        const stopIds = b.filter((r) => r.card_status === "rejected" || r.card_status === "expired").map((r) => r.card_id as string);
        const members: any[] = batchIds.length
          ? await tx.$queryRawUnsafe(
              // Newest batch first, so a cut at the bound only ever shortens the oldest listed batches (pre-review #1).
              `SELECT q.id, q.batch_id, q.text, q.source, q.default_answer, q.queued_at
                 FROM queued_question q JOIN card_batch b ON b.id = q.batch_id
                WHERE q.batch_id = ANY($1::uuid[])
                ORDER BY b.ist_day DESC, b.created_at DESC, b.id, q.queued_at, q.id LIMIT $2`,
              batchIds, BATCH_VIEW_QUESTIONS_MAX,
            )
          : [];
        const waiting: any[] = await tx.$queryRawUnsafe(
          `SELECT id, batch_id, text, source, default_answer, queued_at FROM queued_question
            WHERE project_id = $1::uuid AND batch_id IS NULL ORDER BY queued_at, id LIMIT $2`,
          projectId, BATCH_VIEW_WAITING_MAX,
        );
        const counted: any[] = await tx.$queryRawUnsafe(
          "SELECT count(*)::int AS n FROM queued_question WHERE project_id = $1::uuid AND batch_id IS NULL LIMIT $2",
          projectId, 1,
        );
        const decisions: any[] = cardIds.length
          ? await tx.$queryRawUnsafe(
              `SELECT approval_id, item_id, answer, source FROM project_decision
                WHERE approval_id = ANY($1::uuid[]) AND item_id LIKE 'Q-%' ORDER BY approval_id, item_id LIMIT $2`,
              cardIds, BATCH_VIEW_QUESTIONS_MAX,
            )
          : [];
        const stopped: any[] = stopIds.length
          ? await tx.$queryRawUnsafe(
              `SELECT tb.approval_id, t.id, t.title FROM task_blocker tb JOIN task t ON t.id = tb.task_id
                WHERE tb.approval_id = ANY($1::uuid[]) AND t.status = 'blocked' AND t.project_id = $2::uuid
                ORDER BY tb.approval_id, t.title, t.id LIMIT $3`,
              stopIds, projectId, BATCH_VIEW_TASKS_MAX,
            )
          : [];
        const q = (r: any): BatchQuestionRow => ({ id: r.id, batchId: r.batch_id ?? null, text: r.text, source: r.source, default: r.default_answer, queuedAt: iso(r.queued_at) });
        return {
          batches: b.map((r): BatchRow => ({ id: r.id, istDay: r.ist_day, state: r.state, cardId: r.card_id ?? null, cardStatus: r.card_status ?? null, applied: r.applied === true, handedOff: r.handed_off === true })),
          questions: [...members.map(q), ...waiting.map(q)],
          decisions: decisions.map((r) => ({ approvalId: r.approval_id, itemId: r.item_id, answer: r.answer, source: r.source })),
          stopped: stopped.map((r) => ({ approvalId: r.approval_id, id: r.id, title: r.title })),
          waitingCount: Number(counted[0]?.n ?? 0),
          truncated: members.length >= BATCH_VIEW_QUESTIONS_MAX,
        };
      },
      { timeout: this.timeoutMs, maxWait: this.timeoutMs, isolationLevel: "RepeatableRead" },
    );
  }
}
