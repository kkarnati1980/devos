// M1.6 notifications (docs/modules/M1.6.md): one notice fans out to the dashboard feed, the MyBrain
// bell (HMAC-signed webhook, ADR-0011 §7 / BS-A23) and email (SMTP over TLS). Each channel delivery
// is a `notification` row with its own status; a failed channel never stops the others.
// Errors are fixed codes: a driver, HTTP or SMTP message is never stored, returned or logged.
import { createHmac, randomUUID } from "node:crypto";
import { postBell, type Resolver } from "./bell.js";
import { sendMail, type SmtpConfig } from "./smtp.js";
import { writeAudit, type AuditEntry } from "./settings.js";

export const NOTIFY = Symbol("devos:notify");

/** An invalid notice from any caller; `code` is the `parseNotice` code. Nothing was stored or sent. */
export class NoticeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const CHANNELS = ["dashboard", "mybrain", "email"] as const;
export type Channel = (typeof CHANNELS)[number];
export const NOTICE_KINDS = ["test", "standard_selection", "approval", "info"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
export const REASONS_MAX = 10;
export const REASON_MAX = 300;
/** The MyBrain payload carries a shortened body only (no personal data, ADR-0011 §7). */
export const BELL_SUMMARY_MAX = 500;

export interface NoticeInput {
  kind: NoticeKind;
  title: string;
  body: string;
  reasons: string[];
  projectId: string | null;
  approvalId: string | null;
}

export interface Notice extends NoticeInput {
  id: string;
  createdAt: string;
}

export type DeliveryStatus = "pending" | "sent" | "failed";
export interface Delivery {
  channel: Channel;
  status: DeliveryStatus;
  /** A fixed code, never a transport message. */
  error: string | null;
}

export interface ChannelConfig {
  kind: Channel;
  enabled: boolean;
  /** mybrain: the bell webhook URL; email: the recipient address; dashboard: unused (null). */
  target: string | null;
}

export interface FeedItem extends Notice {
  deliveries: Delivery[];
}

export interface NotificationStore {
  channels(): Promise<ChannelConfig[]>;
  setChannel(kind: Channel, patch: { enabled?: boolean; target?: string | null }, audit: AuditEntry): Promise<ChannelConfig>;
  /** Writes one `pending` row per channel for the notice (dashboard rows are `sent` at once). */
  create(notice: Notice, channels: Channel[], at: Date): Promise<void>;
  /** Records one attempt's outcome for a channel row. */
  record(noticeId: string, channel: Channel, status: "sent" | "failed", error: string | null, at: Date): Promise<void>;
  /** The dashboard feed, newest first. */
  feed(limit: number): Promise<FeedItem[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Printable text; newlines allowed in the body and reasons only. No other control characters.
const LINE = /^[^\x00-\x1f\x7f]*$/;
const TEXT = /^[^\x00-\x09\x0b-\x1f\x7f]*$/;
// Shapes of the secrets DevOS holds (vault names, M1.4) and common tokens. A notice that looks like
// it carries one is refused: notices leave the server (MyBrain, email) and must never carry secrets.
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /lin_api_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

export function looksSecret(s: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(s));
}

/** BS-A01: validates a notice before anything is stored or sent. Returns a code on failure. */
export function parseNotice(v: unknown): NoticeInput | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "body-must-be-object";
  const b = v as Record<string, unknown>;
  const allowed = new Set(["kind", "title", "body", "reasons", "projectId", "approvalId"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return `unknown-field:${k}`;
  if (typeof b.kind !== "string" || !(NOTICE_KINDS as readonly string[]).includes(b.kind)) return "invalid:kind";
  if (typeof b.title !== "string" || b.title.trim().length === 0 || b.title.length > TITLE_MAX || !LINE.test(b.title)) return "invalid:title";
  const body = b.body === undefined ? "" : b.body;
  if (typeof body !== "string" || body.length > BODY_MAX || !TEXT.test(body)) return "invalid:body";
  const reasons = b.reasons === undefined ? [] : b.reasons;
  if (!Array.isArray(reasons) || reasons.length > REASONS_MAX) return "invalid:reasons";
  for (const r of reasons) {
    if (typeof r !== "string" || r.trim().length === 0 || r.length > REASON_MAX || !TEXT.test(r)) return "invalid:reasons";
  }
  if (b.kind === "standard_selection" && reasons.length === 0) return "missing:reasons";
  const id = (k: "projectId" | "approvalId"): string | null | false => {
    const x = b[k];
    if (x === undefined || x === null) return null;
    return typeof x === "string" && UUID.test(x) ? x.toLowerCase() : false;
  };
  const projectId = id("projectId");
  if (projectId === false) return "invalid:projectId";
  const approvalId = id("approvalId");
  if (approvalId === false) return "invalid:approvalId";
  if ([b.title, body, ...reasons].some((s) => looksSecret(s as string))) return "notice-contains-secret";
  return { kind: b.kind as NoticeKind, title: b.title, body, reasons: reasons as string[], projectId, approvalId };
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isEmailAddress(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL.test(s);
}

const isLoopbackHost = (h: string) => h === "127.0.0.1" || h === "[::1]" || h === "localhost";

/**
 * The MyBrain bell URL: `https:` only, no credentials, no fragment, and not an IP literal or
 * `localhost` (the bell is MyBrain's public HTTPS host). `allowLoopbackHttp` is a test-only option;
 * nothing in the environment can set it.
 */
export function checkBellUrl(v: unknown, allowLoopbackHttp = false): string | null {
  if (typeof v !== "string" || v.length > 500) return "invalid:target";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "invalid:target";
  }
  if (u.username || u.password || u.hash) return "invalid:target";
  const loopback = isLoopbackHost(u.hostname);
  if (allowLoopbackHttp && loopback && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "invalid:target-https-only";
  const host = u.hostname.replace(/\.$/, "");
  if (loopback || isLoopbackHost(host) || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || u.hostname.startsWith("[")) return "invalid:target-host";
  // A name that resolves to a private address is refused at send time (bell.ts, PR18-r1).
  return null;
}

export function parseChannelPatch(kind: string, v: unknown, allowLoopbackHttp = false): { kind: Channel; patch: { enabled?: boolean; target?: string | null } } | string {
  if (!(CHANNELS as readonly string[]).includes(kind)) return "invalid:kind";
  if (!v || typeof v !== "object" || Array.isArray(v)) return "body-must-be-object";
  const b = v as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0) return "body-empty";
  for (const k of keys) if (k !== "enabled" && k !== "target") return `unknown-field:${k}`;
  const patch: { enabled?: boolean; target?: string | null } = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return "invalid:enabled";
    patch.enabled = b.enabled;
  }
  if (b.target !== undefined) {
    if (kind === "dashboard") return "invalid:target";
    if (b.target === null) patch.target = null;
    else if (kind === "mybrain") {
      const p = checkBellUrl(b.target, allowLoopbackHttp);
      if (p) return p;
      patch.target = b.target as string;
    } else {
      if (!isEmailAddress(b.target)) return "invalid:target";
      patch.target = b.target;
    }
  }
  return { kind: kind as Channel, patch };
}

/** Signs a bell request: `v1=` + hex HMAC-SHA256 over `<unix seconds>.<raw body>`. */
export function signBell(key: Buffer, timestamp: number, body: string): string {
  return "v1=" + createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

/** The MyBrain bell payload: notice metadata and a shortened body; no secrets, no personal data. */
export function bellPayload(n: Notice, dashboardUrl: string | null) {
  return {
    v: 1,
    source: "devos",
    id: n.id,
    kind: n.kind,
    title: n.title,
    summary: n.body.length > BELL_SUMMARY_MAX ? n.body.slice(0, BELL_SUMMARY_MAX - 1) + "…" : n.body,
    reasons: n.reasons,
    link: dashboardUrl ? `${dashboardUrl}/notifications#${n.id}` : null,
    createdAt: n.createdAt,
  };
}

export type NotifySecret = "mybrain_bell_key" | "smtp_password";
/** The M1.4 vault, for a server-side consumer: `reveal` decrypts at send time; `isSet` reads metadata only. */
export interface SecretReader {
  reveal(name: NotifySecret): Promise<string | null>;
  isSet(name: NotifySecret): Promise<boolean>;
}

export interface NotifierConfig {
  /**
   * The bell HMAC key (`mybrain_bell_key`) and the SMTP password (`smtp_password`) are vault
   * secrets entered in the setup wizard; they are read at send time and never leave this module.
   * Without a vault the bell and authenticated email answer `*-not-configured`.
   */
  secrets: SecretReader | null;
  /** SMTP host, port, TLS mode, user and sender from `DEVOS_SMTP_*` (null → email off). */
  smtp: SmtpConfig | null;
  dashboardUrl: string | null;
  timeoutMs: number;
  /** Test-only: lets a stub bell listen on loopback http. Never set from the environment. */
  allowLoopbackHttp?: boolean;
  /** Test-only DNS resolver for the bell (defaults to the system resolver). */
  resolve?: Resolver;
  send?: typeof sendMail;
  now?: () => number;
}

export class Notifier {
  constructor(
    readonly store: NotificationStore,
    readonly cfg: NotifierConfig,
  ) {}

  private now() {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private async secret(name: NotifySecret): Promise<string | null> {
    return this.cfg.secrets ? this.cfg.secrets.reveal(name) : null;
  }

  /** Which channels have their server-side configuration (names only; nothing is decrypted). */
  async configured(): Promise<{ mybrain: boolean; email: boolean }> {
    const s = this.cfg.secrets;
    const bell = s ? await s.isSet("mybrain_bell_key") : false;
    const pass = !this.cfg.smtp?.user || (s ? await s.isSet("smtp_password") : false);
    return { mybrain: bell, email: this.cfg.smtp !== null && pass };
  }

  /**
   * Validates the notice (PR18-r1: every caller, not only routes, goes through `parseNotice`), stores
   * it for every enabled channel, then delivers it to MyBrain and email. A channel failure is
   * recorded on its row and returned. Throws `NoticeError` for an invalid notice (nothing stored or
   * sent) and `notifications-store-error` if the notice or any delivery outcome cannot be stored.
   */
  async notify(input: NoticeInput): Promise<{ notice: Notice; deliveries: Delivery[] }> {
    const valid = parseNotice(input);
    if (typeof valid === "string") throw new NoticeError(valid);
    const notice: Notice = { ...valid, id: randomUUID(), createdAt: new Date(this.now()).toISOString() };
    const channels = await this.store.channels();
    const enabled = channels.filter((c) => c.enabled);
    await this.store.create(
      notice,
      enabled.map((c) => c.kind),
      new Date(this.now()),
    );
    let recordFailed = false;
    const deliveries = await Promise.all(
      enabled.map(async (c): Promise<Delivery> => {
        if (c.kind === "dashboard") return { channel: "dashboard", status: "sent", error: null };
        const error = await this.deliver(c, notice);
        const status = error ? "failed" : "sent";
        try {
          await this.store.record(notice.id, c.kind, status, error, new Date(this.now()));
        } catch {
          recordFailed = true;
        }
        return { channel: c.kind, status, error };
      }),
    );
    // A delivery whose outcome could not be stored is a store failure, never a 201 (PR18-r1).
    if (recordFailed) throw new Error("notifications-store-error");
    return { notice, deliveries };
  }

  private async deliver(c: ChannelConfig, n: Notice): Promise<string | null> {
    try {
      return c.kind === "mybrain" ? await this.bell(c.target, n) : await this.email(c.target, n);
    } catch {
      return `${c.kind}-error`;
    }
  }

  private async bell(target: string | null, n: Notice): Promise<string | null> {
    if (!target || checkBellUrl(target, this.cfg.allowLoopbackHttp)) return "mybrain-no-target";
    let key: string | null;
    try {
      key = await this.secret("mybrain_bell_key");
    } catch {
      return "mybrain-key-unavailable";
    }
    if (!key) return "mybrain-not-configured";
    const body = JSON.stringify(bellPayload(n, this.cfg.dashboardUrl));
    const ts = Math.floor(this.now() / 1000);
    return postBell({
      url: target,
      headers: {
        "content-type": "application/json",
        "x-devos-timestamp": String(ts),
        "x-devos-signature": signBell(Buffer.from(key, "utf8"), ts, body),
        "x-devos-notice-id": n.id,
      },
      body,
      timeoutMs: this.cfg.timeoutMs,
      allowLoopback: this.cfg.allowLoopbackHttp,
      resolve: this.cfg.resolve,
    });
  }

  private async email(target: string | null, n: Notice): Promise<string | null> {
    if (!this.cfg.smtp) return "email-not-configured";
    if (!isEmailAddress(target)) return "email-no-target";
    let pass: string | null = null;
    if (this.cfg.smtp.user) {
      try {
        pass = await this.secret("smtp_password");
      } catch {
        return "email-password-unavailable";
      }
      if (!pass) return "email-not-configured";
    }
    const lines = [n.body, ...(n.reasons.length ? ["", "Reasons:", ...n.reasons.map((r) => `- ${r}`)] : [])];
    if (this.cfg.dashboardUrl) lines.push("", `${this.cfg.dashboardUrl}/notifications#${n.id}`);
    const send = this.cfg.send ?? sendMail;
    return send({ ...this.cfg.smtp, pass }, { to: target, subject: `[DevOS] ${n.title}`, text: lines.join("\n"), messageId: n.id }, this.cfg.timeoutMs);
  }
}

const DEFAULT_ENABLED: Record<Channel, boolean> = { dashboard: true, mybrain: true, email: true };

function noticeFromRow(r: any): Notice {
  return {
    id: r.noticeId,
    kind: r.kind,
    title: r.title,
    body: r.body ?? "",
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    projectId: r.projectId ?? null,
    approvalId: r.approvalId ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

/** In-memory store for tests and for a server started without a database. */
export class MemoryNotificationStore implements NotificationStore {
  rows: Array<{ noticeId: string; channel: Channel; status: DeliveryStatus; attempts: number; error: string | null; notice: Notice; createdAt: Date; sentAt: Date | null }> = [];
  chans = new Map<Channel, ChannelConfig>();
  audits: AuditEntry[] = [];
  failAudit = false;

  async channels() {
    return CHANNELS.map((k) => this.chans.get(k) ?? { kind: k, enabled: DEFAULT_ENABLED[k], target: null });
  }
  async setChannel(kind: Channel, patch: { enabled?: boolean; target?: string | null }, audit: AuditEntry) {
    if (this.failAudit) throw new Error("audit failed");
    const cur = (await this.channels()).find((c) => c.kind === kind)!;
    const next = { ...cur, ...patch };
    this.chans.set(kind, next);
    this.audits.push(audit);
    return next;
  }
  async create(notice: Notice, channels: Channel[], at: Date) {
    for (const channel of channels) {
      const sent = channel === "dashboard";
      this.rows.push({ noticeId: notice.id, channel, status: sent ? "sent" : "pending", attempts: sent ? 1 : 0, error: null, notice, createdAt: at, sentAt: sent ? at : null });
    }
  }
  async record(noticeId: string, channel: Channel, status: "sent" | "failed", error: string | null, at: Date) {
    const r = this.rows.find((x) => x.noticeId === noticeId && x.channel === channel);
    if (!r) return;
    r.status = status;
    r.error = error;
    r.attempts += 1;
    if (status === "sent") r.sentAt = at;
  }
  /** Newest notices across every stored channel, so a notice is listed even with the dashboard off (PR18-r1). */
  async feed(limit: number) {
    const seen = new Map<string, Notice>();
    for (const r of [...this.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.noticeId < b.noticeId ? -1 : 1))) {
      if (!seen.has(r.noticeId)) seen.set(r.noticeId, r.notice);
      if (seen.size === limit) break;
    }
    return [...seen.values()].map((n) => ({
      ...n,
      deliveries: this.rows.filter((r) => r.noticeId === n.id).map((r) => ({ channel: r.channel, status: r.status, error: r.error })),
    }));
  }
}

/**
 * Prisma store. Every operation, reads included, runs in a transaction bounded by `timeout` and
 * `maxWait` (ADR-0011 §9, as M1.4); a channel change commits with its audit event.
 */
export class PrismaNotificationStore implements NotificationStore {
  constructor(
    private readonly db: { $transaction<T>(fn: (tx: any) => Promise<T>, o?: { timeout?: number; maxWait?: number }): Promise<T> },
    private readonly timeoutMs: number,
  ) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  async channels() {
    return this.tx(async (tx) => {
      const rows: Array<{ kind: Channel; enabled: boolean; target: string | null }> = await tx.notificationChannel.findMany();
      return CHANNELS.map((k) => {
        const r = rows.find((x) => x.kind === k);
        return r ? { kind: k, enabled: r.enabled, target: r.target ?? null } : { kind: k, enabled: DEFAULT_ENABLED[k], target: null };
      });
    });
  }

  async setChannel(kind: Channel, patch: { enabled?: boolean; target?: string | null }, audit: AuditEntry) {
    return this.tx(async (tx) => {
      const r = await tx.notificationChannel.upsert({
        where: { kind },
        create: { kind, enabled: patch.enabled ?? DEFAULT_ENABLED[kind], target: patch.target ?? null },
        update: patch,
      });
      await writeAudit(tx, audit);
      return { kind, enabled: r.enabled, target: r.target ?? null };
    });
  }

  async create(notice: Notice, channels: Channel[], at: Date) {
    await this.tx(async (tx) => {
      await tx.notification.createMany({
        data: channels.map((channel) => ({
          noticeId: notice.id,
          kind: notice.kind,
          title: notice.title,
          body: notice.body,
          reasons: notice.reasons,
          projectId: notice.projectId,
          approvalId: notice.approvalId,
          channel,
          status: channel === "dashboard" ? "sent" : "pending",
          attempts: channel === "dashboard" ? 1 : 0,
          sentAt: channel === "dashboard" ? at : null,
          createdAt: new Date(notice.createdAt),
        })),
      });
    });
  }

  async record(noticeId: string, channel: Channel, status: "sent" | "failed", error: string | null, at: Date) {
    await this.tx(async (tx) => {
      await tx.notification.updateMany({
        where: { noticeId, channel },
        data: { status, error, attempts: { increment: 1 }, ...(status === "sent" ? { sentAt: at } : {}) },
      });
    });
  }

  /**
   * Newest `limit` notices across every channel (PR18-r1: not only dashboard rows). A notice has at
   * most one row per channel and all its rows share `created_at`, so the newest `limit × channels`
   * rows, ordered by (created_at, notice_id), contain every row of the newest `limit` notices.
   */
  async feed(limit: number) {
    return this.tx(async (tx) => {
      const recent = await tx.notification.findMany({
        where: { noticeId: { not: null } },
        orderBy: [{ createdAt: "desc" }, { noticeId: "asc" }],
        take: limit * CHANNELS.length,
        select: { noticeId: true },
      });
      const ids = [...new Set(recent.map((r: any) => r.noticeId as string))].slice(0, limit);
      if (ids.length === 0) return [];
      const rows = await tx.notification.findMany({ where: { noticeId: { in: ids } } });
      return ids.map((id) => {
        const mine = rows.filter((r: any) => r.noticeId === id);
        return {
          ...noticeFromRow(mine[0]),
          deliveries: mine.map((r: any) => ({ channel: r.channel, status: r.status, error: r.error ?? null })),
        };
      });
    });
  }
}

/** `DEVOS_DASHBOARD_URL`: an exact `https://host[:port]` (or http on loopback) used for links. */
export function parseDashboardUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === v && !u.username) return u.origin;
  } catch {}
  throw new Error("config-dashboard-url-invalid");
}
