// M2.3 decision cards (docs/modules/M2.3.md): ACTION / TARGET / REASON cards, KK-only decisions that issue one
// scoped, expiring, limited-use M1.7 grant, and blocked tasks that wait only on the cards they depend on.
import { createHash } from "node:crypto";
import { looksSecret, type NoticeInput } from "./notify.js";
import type { KkSession } from "./auth.js";

export const APPROVALS = Symbol("devos:approvals");

export const GATES = ["requirements", "decision", "first_launch", "destructive_or_spend", "purge"] as const;
export type GateName = (typeof GATES)[number];
export type CardStatus = "pending" | "approved" | "rejected" | "expired";
export type TaskState = "blocked" | "ready" | "running" | "done" | "failed" | "deadlocked";

export class ApprovalError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export const ACTION_MAX = 200;
export const REASON_MAX = 2000;
export const COMMENT_MAX = 2000;
export const DEFAULT_GRANT_HOURS = 24;
export const MAX_GRANT_HOURS = 90 * 24;
export const DEFAULT_CARD_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface CardInput {
  gate: GateName;
  action: string;
  target: string;
  reason: string;
  costUsd?: string | null;
  consequence?: string | null;
  projectId?: string | null;
}

export interface Card extends Required<CardInput> {
  id: string;
  status: CardStatus;
  decidedAt: Date | null;
  decidedBy: string | null;
  confirmationHash: string | null;
  createdAt: Date;
}

export interface CardComment {
  id: string;
  approvalId: string;
  author: string;
  body: string;
  createdAt: Date;
}

export interface AuditEntry {
  action: string;
  summary: string;
  details: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/;
const MULTI_LINE = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/;

function text(v: unknown, max: number, multiLine: boolean): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 1 || s.length > max) return null;
  return (multiLine ? MULTI_LINE : ONE_LINE).test(s) ? s : null;
}

/** BS-A01: validates a card before anything is stored or sent. Returns a code on failure. */
export function parseCard(v: unknown): CardInput | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "invalid-input";
  const b = v as Record<string, unknown>;
  const allowed = new Set(["gate", "action", "target", "reason", "costUsd", "consequence", "projectId"]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return "invalid-input";
  if (typeof b.gate !== "string" || !(GATES as readonly string[]).includes(b.gate)) return "invalid-input";
  const action = text(b.action, ACTION_MAX, false);
  const target = text(b.target, ACTION_MAX, false);
  const reason = text(b.reason, REASON_MAX, true);
  if (!action || !target || !reason) return "invalid-input";
  let consequence: string | null = null;
  if (b.consequence != null) {
    consequence = text(b.consequence, REASON_MAX, true);
    if (!consequence) return "invalid-input";
  }
  let costUsd: string | null = null;
  if (b.costUsd != null) {
    if (typeof b.costUsd !== "string" || !/^\d{1,6}(\.\d{1,6})?$/.test(b.costUsd)) return "invalid-input";
    costUsd = b.costUsd;
  }
  let projectId: string | null = null;
  if (b.projectId != null) {
    if (typeof b.projectId !== "string" || !UUID.test(b.projectId)) return "invalid-input";
    projectId = b.projectId;
  }
  if ([action, target, reason, consequence ?? ""].some(looksSecret)) return "card-contains-secret";
  return { gate: b.gate as GateName, action, target, reason, costUsd, consequence, projectId };
}

/** Gate 5: the hash KK's typed confirmation must match. */
export function purgeConfirmationHash(target: string): string {
  return createHash("sha256").update(`PURGE ${target}`, "utf8").digest("hex");
}

/**
 * Persistence. Each method is one transaction; `decide` locks the card row so concurrent decisions serialise.
 * Implementations: MemoryApprovalStore (tests) and PrismaApprovalStore (Postgres).
 */
export interface ApprovalStore {
  /** Create the card (or return the pending duplicate), add blockers, set the tasks blocked, audit. */
  raise(input: CardInput, blocks: readonly string[], audit: AuditEntry, now: Date): Promise<{ card: Card; created: boolean }>;
  get(id: string): Promise<Card | null>;
  list(filter: { status?: CardStatus; projectId?: string; cursor?: string; limit: number }): Promise<Card[]>;
  blockedTasks(approvalId: string): Promise<{ id: string; title: string; status: TaskState }[]>;
  comments(approvalId: string): Promise<CardComment[]>;
  /**
   * Under a row lock: if the card is pending, set the decision, add the optional comment, audit, and (for an
   * approval) set each task it blocks to ready when no other blocker is pending, rejected or expired.
   * Returns null when the card is missing or no longer pending (nothing changes).
   */
  decide(
    id: string,
    d: { status: "approved" | "rejected"; by: string; at: Date; confirmationHash?: string | null; comment?: string | null },
    audit: AuditEntry,
  ): Promise<Card | null>;
  comment(approvalId: string, author: string, body: string, at: Date): Promise<CardComment | null>;
  /** Pending cards created before `before` become expired (audited); their tasks stay blocked. */
  expire(before: Date, at: Date): Promise<string[]>;
}

/** The M1.7 engine surface M2.3 needs (structural; `@devos/policy` PolicyEngine). */
export interface GrantIssuer {
  issueGrant(
    session: KkSession,
    scope: {
      approvalId?: string | null;
      scopeAction: string;
      scopeResource?: string | null;
      projectId?: string | null;
      sha?: string | null;
      expiresAt: Date;
      maxUses?: number;
    },
  ): Promise<{ id: string; expiresAt: Date; maxUses: number; uses: number }>;
  revokeGrant(session: KkSession, grantId: string): Promise<boolean>;
}

export interface CardNotifier {
  notify(n: NoticeInput): Promise<unknown>;
}

export interface ApproveOptions {
  expiresInHours?: number;
  maxUses?: number;
  sha?: string | null;
  confirmation?: string | null;
}

export function parseApproveOptions(v: unknown): ApproveOptions | string {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return "invalid-input";
  const b = v as Record<string, unknown>;
  const allowed = new Set(["expiresInHours", "maxUses", "sha", "confirmation"]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return "invalid-input";
  const out: ApproveOptions = {};
  if (b.expiresInHours != null) {
    if (!Number.isInteger(b.expiresInHours) || (b.expiresInHours as number) < 1 || (b.expiresInHours as number) > MAX_GRANT_HOURS) return "invalid-input";
    out.expiresInHours = b.expiresInHours as number;
  }
  if (b.maxUses != null) {
    if (!Number.isInteger(b.maxUses) || (b.maxUses as number) < 1 || (b.maxUses as number) > 100) return "invalid-input";
    out.maxUses = b.maxUses as number;
  }
  if (b.sha != null) {
    if (typeof b.sha !== "string" || !/^[0-9a-f]{40}$/.test(b.sha)) return "invalid-input";
    out.sha = b.sha;
  }
  if (b.confirmation != null) {
    if (typeof b.confirmation !== "string" || b.confirmation.length > ACTION_MAX + 6) return "invalid-input";
    out.confirmation = b.confirmation;
  }
  return out;
}

export interface ApprovalsDeps {
  store: ApprovalStore;
  grants: GrantIssuer;
  notifier: CardNotifier | null;
  /** M1.7 `verifyKkSession`: true only for a session this process minted for KK. */
  verifyKkSession: (s: unknown) => boolean;
  now?: () => number;
}

/** The policy decision shape `cardForDecision` reads (structural; `@devos/policy` PolicyDecision). */
export interface DecisionLike {
  enforcedOutcome: "allow" | "deny" | "require_approval";
  reason: string;
}

export class Approvals {
  private readonly now: () => number;
  constructor(private readonly deps: ApprovalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  get store(): ApprovalStore {
    return this.deps.store;
  }

  private requireKk(session: unknown): string {
    const s = session as KkSession | null;
    if (!this.deps.verifyKkSession(session) || s?.identity?.type !== "kk" || !/^kk:.+/.test(s.identity.id)) {
      throw new ApprovalError("not-kk", 403);
    }
    return s.identity.id;
  }

  /** Raise a card (deduped against a pending twin), block the listed tasks, then notify once. */
  async raiseCard(input: unknown, blocks: readonly string[] = []): Promise<Card> {
    const card = parseCard(input);
    if (typeof card === "string") throw new ApprovalError(card);
    if (blocks.some((t) => typeof t !== "string" || !UUID.test(t))) throw new ApprovalError("invalid-input");
    const audit = { action: "approval.raised", summary: `Decision card: ${card.action}`, details: { gate: card.gate, blocks: blocks.length } };
    const { card: stored, created } = await this.deps.store.raise(card, blocks, audit, new Date(this.now()));
    if (created && this.deps.notifier) {
      // A notification failure never undoes the card; the feed shows the failed delivery (no resend, ADR-0011 §9).
      await this.deps.notifier
        .notify({
          kind: "approval",
          title: stored.action.slice(0, 120),
          body: `${stored.target}\n\n${stored.reason}`.slice(0, 2000),
          reasons: [`Gate: ${stored.gate}`],
          projectId: stored.projectId,
          approvalId: stored.id,
        })
        .catch(() => undefined);
    }
    return stored;
  }

  /** ADR-0006: a card only from an enforced `require_approval` outcome; the requesting task waits on it. */
  async cardForDecision(
    decision: DecisionLike,
    request: { action: string; resource: string; projectId?: string | null; gate?: GateName; taskId?: string | null },
  ): Promise<Card> {
    if (decision.enforcedOutcome !== "require_approval") throw new ApprovalError("card-not-required");
    return this.raiseCard(
      {
        gate: request.gate ?? "decision",
        action: request.action,
        target: request.resource,
        reason: decision.reason || "Policy requires approval",
        projectId: request.projectId ?? null,
      },
      request.taskId ? [request.taskId] : [],
    );
  }

  /**
   * KK approves: the grant is issued first, then the card is decided under its row lock. If the card is no longer
   * pending (a concurrent decision won), the grant just issued is revoked, so at most one live grant exists.
   */
  async approve(session: unknown, id: string, options: ApproveOptions = {}): Promise<{ card: Card; grantId: string }> {
    const by = this.requireKk(session);
    if (!UUID.test(id)) throw new ApprovalError("card-not-found", 404);
    const card = await this.deps.store.get(id);
    if (!card) throw new ApprovalError("card-not-found", 404);
    if (card.status !== "pending") throw new ApprovalError("card-not-pending", 409);
    let confirmationHash: string | null = null;
    if (card.gate === "purge") {
      const expected = purgeConfirmationHash(card.target);
      const given = options.confirmation == null ? "" : createHash("sha256").update(options.confirmation, "utf8").digest("hex");
      if (given !== expected) throw new ApprovalError("purge-confirmation-mismatch", 409);
      confirmationHash = expected;
    }
    const at = new Date(this.now());
    const hours = options.expiresInHours ?? DEFAULT_GRANT_HOURS;
    const grant = await this.deps.grants.issueGrant(session as KkSession, {
      approvalId: card.id,
      scopeAction: card.action,
      scopeResource: card.target,
      projectId: card.projectId,
      sha: options.sha ?? null,
      expiresAt: new Date(at.getTime() + hours * 3600 * 1000),
      maxUses: options.maxUses ?? 1,
    });
    const decided = await this.deps.store
      .decide(
        id,
        { status: "approved", by, at, confirmationHash },
        { action: "approval.approved", summary: `Approved: ${card.action}`, details: { gate: card.gate, grantId: grant.id } },
      )
      .catch(async (e: unknown) => {
        await this.deps.grants.revokeGrant(session as KkSession, grant.id).catch(() => undefined);
        throw e;
      });
    if (!decided) {
      await this.deps.grants.revokeGrant(session as KkSession, grant.id).catch(() => undefined);
      throw new ApprovalError("card-not-pending", 409);
    }
    return { card: decided, grantId: grant.id };
  }

  async reject(session: unknown, id: string, comment?: unknown): Promise<Card> {
    const by = this.requireKk(session);
    if (!UUID.test(id)) throw new ApprovalError("card-not-found", 404);
    let body: string | null = null;
    if (comment != null) {
      body = text(comment, COMMENT_MAX, true);
      if (!body) throw new ApprovalError("invalid-input");
    }
    const card = await this.deps.store.get(id);
    if (!card) throw new ApprovalError("card-not-found", 404);
    const decided = await this.deps.store.decide(
      id,
      { status: "rejected", by, at: new Date(this.now()), comment: body },
      { action: "approval.rejected", summary: `Rejected: ${card.action}`, details: { gate: card.gate, comment: body !== null } },
    );
    if (!decided) throw new ApprovalError("card-not-pending", 409);
    return decided;
  }

  async comment(session: unknown, id: string, body: unknown): Promise<CardComment> {
    const by = this.requireKk(session);
    if (!UUID.test(id)) throw new ApprovalError("card-not-found", 404);
    const b = text(body, COMMENT_MAX, true);
    if (!b) throw new ApprovalError("invalid-input");
    const c = await this.deps.store.comment(id, by, b, new Date(this.now()));
    if (!c) throw new ApprovalError("card-not-found", 404);
    return c;
  }

  /** Pending cards older than the window expire; their tasks stay blocked. */
  async expireCards(windowMs = DEFAULT_CARD_WINDOW_MS): Promise<string[]> {
    const now = this.now();
    return this.deps.store.expire(new Date(now - windowMs), new Date(now));
  }
}

/** In-memory store for tests and local runs: same semantics as the Postgres store, serialised by a promise lock. */
export class MemoryApprovalStore implements ApprovalStore {
  readonly cards = new Map<string, Card>();
  readonly blockers: { taskId: string; approvalId: string }[] = [];
  readonly tasks = new Map<string, { id: string; title: string; status: TaskState }>();
  readonly commentsList: CardComment[] = [];
  readonly audit: AuditEntry[] = [];
  private seq = 0;
  private lock: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private uuid(): string {
    this.seq++;
    return `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`;
  }

  addTask(id: string, title: string, status: TaskState = "ready"): void {
    this.tasks.set(id, { id, title, status });
  }

  raise(input: CardInput, blocks: readonly string[], audit: AuditEntry, now: Date) {
    return this.serial(() => {
      for (const t of blocks) if (!this.tasks.has(t)) throw new ApprovalError("task-not-found", 404);
      let card = [...this.cards.values()].find(
        (c) => c.status === "pending" && c.projectId === (input.projectId ?? null) && c.gate === input.gate && c.action === input.action && c.target === input.target,
      );
      const created = !card;
      if (!card) {
        card = {
          gate: input.gate,
          action: input.action,
          target: input.target,
          reason: input.reason,
          costUsd: input.costUsd ?? null,
          consequence: input.consequence ?? null,
          projectId: input.projectId ?? null,
          id: this.uuid(),
          status: "pending",
          decidedAt: null,
          decidedBy: null,
          confirmationHash: null,
          createdAt: now,
        };
        this.cards.set(card.id, card);
      }
      for (const t of blocks) {
        if (!this.blockers.some((b) => b.taskId === t && b.approvalId === card.id)) this.blockers.push({ taskId: t, approvalId: card.id });
        const task = this.tasks.get(t);
        if (task && (task.status === "ready" || task.status === "blocked")) task.status = "blocked";
      }
      this.audit.push(audit);
      return { card: { ...card }, created };
    });
  }

  async get(id: string) {
    const c = this.cards.get(id);
    return c ? { ...c } : null;
  }

  async list(f: { status?: CardStatus; projectId?: string; cursor?: string; limit: number }) {
    let all = [...this.cards.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    if (f.status) all = all.filter((c) => c.status === f.status);
    if (f.projectId) all = all.filter((c) => c.projectId === f.projectId);
    if (f.cursor) {
      const i = all.findIndex((c) => c.id === f.cursor);
      all = i < 0 ? [] : all.slice(i + 1);
    }
    return all.slice(0, f.limit).map((c) => ({ ...c }));
  }

  async blockedTasks(approvalId: string) {
    return this.blockers.filter((b) => b.approvalId === approvalId).map((b) => ({ ...(this.tasks.get(b.taskId) as { id: string; title: string; status: TaskState }) }));
  }

  async comments(approvalId: string) {
    return this.commentsList.filter((c) => c.approvalId === approvalId).map((c) => ({ ...c }));
  }

  decide(
    id: string,
    d: { status: "approved" | "rejected"; by: string; at: Date; confirmationHash?: string | null; comment?: string | null },
    audit: AuditEntry,
  ) {
    return this.serial(() => {
      const card = this.cards.get(id);
      if (!card || card.status !== "pending") return null;
      card.status = d.status;
      card.decidedAt = d.at;
      card.decidedBy = d.by;
      if (d.confirmationHash) card.confirmationHash = d.confirmationHash;
      if (d.comment) this.commentsList.push({ id: this.uuid(), approvalId: id, author: d.by, body: d.comment, createdAt: d.at });
      if (d.status === "approved") {
        for (const b of this.blockers.filter((x) => x.approvalId === id)) {
          const others = this.blockers.filter((x) => x.taskId === b.taskId && x.approvalId !== id);
          const stillWaiting = others.some((o) => this.cards.get(o.approvalId)?.status !== "approved");
          const task = this.tasks.get(b.taskId);
          if (task && task.status === "blocked" && !stillWaiting) task.status = "ready";
        }
      }
      this.audit.push(audit);
      return { ...card };
    });
  }

  comment(approvalId: string, author: string, body: string, at: Date) {
    return this.serial(() => {
      if (!this.cards.has(approvalId)) return null;
      const c = { id: this.uuid(), approvalId, author, body, createdAt: at };
      this.commentsList.push(c);
      return { ...c };
    });
  }

  expire(before: Date, at: Date) {
    return this.serial(() => {
      const ids: string[] = [];
      for (const c of this.cards.values()) {
        if (c.status === "pending" && c.createdAt.getTime() < before.getTime()) {
          c.status = "expired";
          c.decidedAt = at;
          c.decidedBy = "system:expiry";
          ids.push(c.id);
          this.audit.push({ action: "approval.expired", summary: `Expired: ${c.action}`, details: { gate: c.gate } });
        }
      }
      return ids;
    });
  }
}
