// M1.4 browser client for the DevOS API (docs/modules/M1.4.md). The browser calls the API origin
// directly with the session cookie (credentials: "include"), so the API sees KK's tailnet peer.
// The CSRF token is kept in memory only, never in storage or the URL. Secret values are sent once
// and never kept: callers clear their field after a save.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export interface SettingsView {
  anthropicCapUsd: string;
  openaiCapUsd: string;
  defaultProjectCapUsd: string;
  defaultLanes: number;
  maxLanes: number;
  deadlockAttempts: number;
  /** DEVOS-176: the analyst model pass (`analyst.model_pass`), default off. */
  analystModelPass: boolean;
  capsConfirmedAt: string | null;
  updatedAt: string | null;
}

export interface SecretMeta {
  name: string;
  set: boolean;
  hint: string | null;
  keyVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SetupStatus {
  capsConfirmed: boolean;
  vaultConfigured: boolean;
  secrets: { name: string; set: boolean }[];
  complete: boolean;
}

const TIMEOUT_MS = 10_000; // ADR-0011 §9: every outbound call has a timeout

/**
 * M2.3-b2 (DEVOS-135): page-wide signals for the nav's pending-approvals count. The nav never signs in
 * itself (a second sign-in would rotate the cookie and stale the page's CSRF token, and an unsigned
 * probe would log a 401), so it waits until a page's DevosApi holds a session, then only reads.
 */
export const SESSION_EVENT = "devos:session";
export const APPROVALS_CHANGED_EVENT = "devos:approvals-changed";
let sessionSeen = false;
export function hasSession(): boolean {
  return sessionSeen;
}
function markSession(): void {
  sessionSeen = true;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EVENT));
}

/** ADR-0012 CR-a3 (DEVOS-199): the project page's read-only pre-flight view. Secret items carry names only. */
export interface PreflightItemView {
  id: string;
  kind: "decision" | "secret";
  text: string;
  default: string;
  options?: string[];
  blocks?: string[];
}
export interface PreflightView {
  continuousRun: boolean;
  state: "pending" | "approved" | "rejected" | null;
  open: boolean;
  items: PreflightItemView[];
  missingSecrets: string[];
  secretsUnverified: boolean;
  decisions: { itemId: string; answer: string; source: string; createdAt: string }[];
}

/** M1.6 notifications. */
export type ChannelKind = "dashboard" | "mybrain" | "email";
export interface Delivery {
  channel: ChannelKind;
  status: "pending" | "sent" | "failed";
  error: string | null;
}
export interface NoticeItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  reasons: string[];
  createdAt: string;
  deliveries: Delivery[];
}
export interface ChannelView {
  kind: ChannelKind;
  enabled: boolean;
  target: string | null;
  configured: boolean;
}

export class DevosApi {
  private csrf: string | null = null;
  constructor(private readonly origin: string) {}

  /**
   * A write refused before it took effect because another tab signed in (new cookie, so this tab's
   * CSRF token is stale) or the 12-hour session ended is retried once after recovering the token
   * (PR17-r1). Both refusals happen in the API guard, before any change, so the retry is safe.
   */
  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const first = await this.once<T>(method, path, body);
    if (first.ok || method === "GET" || path === "/auth/session") return first;
    if (first.code === "csrf-token-invalid") {
      const r = await this.refresh();
      if (!r.ok) return first;
    } else if (first.status === 401) {
      const r = await this.signIn();
      if (!r.ok) return first;
    } else return first;
    return this.once<T>(method, path, body);
  }

  private async once<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (method !== "GET" && this.csrf) headers["x-devos-csrf"] = this.csrf;
      const res = await fetch(this.origin + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: ctl.signal,
      });
      const json = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) return { ok: false, status: res.status, code: typeof json?.code === "string" ? json.code : "api-error" };
      return { ok: true, data: json as T };
    } catch {
      return { ok: false, status: 0, code: "api-unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Re-reads the CSRF token for the current cookie (shared by every tab), without rotating it. */
  private async refresh(): Promise<ApiResult<{ login: string; expiresAt: string }>> {
    const r = await this.once<{ login: string; expiresAt: string; csrfToken: string }>("GET", "/auth/session");
    if (!r.ok) return r;
    this.csrf = r.data.csrfToken;
    markSession();
    return { ok: true, data: { login: r.data.login, expiresAt: r.data.expiresAt } };
  }

  /**
   * Page load: reuse the session another tab may already hold (no cookie rotation, so open tabs
   * keep working); sign in only when there is no valid session.
   */
  async connect(): Promise<ApiResult<{ login: string; expiresAt: string }>> {
    const r = await this.refresh();
    if (r.ok || r.status !== 401) return r;
    return this.signIn();
  }

  /** Sign-in: a fresh 12-hour session for KK's tailnet identity; keeps the CSRF token in memory. */
  async signIn(): Promise<ApiResult<{ login: string; expiresAt: string }>> {
    const r = await this.once<{ login: string; expiresAt: string; csrfToken: string }>("POST", "/auth/session");
    if (!r.ok) return r;
    this.csrf = r.data.csrfToken;
    markSession();
    return { ok: true, data: { login: r.data.login, expiresAt: r.data.expiresAt } };
  }

  setup() {
    return this.call<SetupStatus>("GET", "/setup");
  }
  saveCaps(caps: { anthropicCapUsd: string; openaiCapUsd: string; defaultProjectCapUsd: string }) {
    return this.call<{ settings: SettingsView }>("PUT", "/setup/caps", caps);
  }
  settings() {
    return this.call<{ settings: SettingsView }>("GET", "/settings");
  }
  saveSettings(patch: Partial<Pick<SettingsView, "anthropicCapUsd" | "openaiCapUsd" | "defaultProjectCapUsd" | "defaultLanes" | "deadlockAttempts" | "analystModelPass">>) {
    return this.call<{ settings: SettingsView }>("PUT", "/settings", patch);
  }
  secrets() {
    return this.call<{ secrets: SecretMeta[] }>("GET", "/vault/secrets");
  }
  saveSecret(name: string, value: string) {
    return this.call<{ secret: SecretMeta; rotated: boolean }>("PUT", `/vault/secrets/${encodeURIComponent(name)}`, { value });
  }
  notifications() {
    return this.call<{ notices: NoticeItem[] }>("GET", "/notifications");
  }
  channels() {
    return this.call<{ channels: ChannelView[] }>("GET", "/notifications/channels");
  }
  saveChannel(kind: ChannelKind, patch: { enabled?: boolean; target?: string | null }) {
    return this.call<{ channel: Omit<ChannelView, "configured"> }>("PUT", `/notifications/channels/${kind}`, patch);
  }
  sendTest() {
    return this.call<{ deliveries: Delivery[] }>("POST", "/notifications/test");
  }
  /** DEVOS-77 dead-letter view. */
  deadLetters() {
    return this.call<{ deadLetters: DeadLetter[] }>("GET", "/runs/dead-letters");
  }
  retryDeadLetter(jobId: string) {
    return this.call<{ retried: string }>("POST", `/runs/dead-letters/${encodeURIComponent(jobId)}/retry`);
  }
  /** ADR-0012 CR-a3 (DEVOS-199). */
  preflight(slug: string) {
    return this.call<{ preflight: PreflightView }>("GET", `/projects/by-slug/${encodeURIComponent(slug)}/preflight`);
  }
  /** M2.3-b2 (DEVOS-135): the approvals inbox over the M2.3-b1 routes. */
  approvals(query: { status?: ApprovalStatus; cursor?: string } = {}) {
    const q = new URLSearchParams();
    if (query.status) q.set("status", query.status);
    if (query.cursor) q.set("cursor", query.cursor);
    const qs = q.toString();
    return this.call<{ approvals: ApprovalRow[]; nextCursor: string | null }>("GET", `/approvals${qs ? `?${qs}` : ""}`);
  }
  approval(id: string) {
    return this.call<ApprovalDetail>("GET", `/approvals/${encodeURIComponent(id)}`);
  }
  approve(id: string, body: { expiresInHours?: number; maxUses?: number; confirmation?: string }) {
    return this.call<{ approval: ApprovalCard; grantId: string }>("POST", `/approvals/${encodeURIComponent(id)}/approve`, body);
  }
  reject(id: string, comment?: string) {
    return this.call<{ approval: ApprovalCard }>("POST", `/approvals/${encodeURIComponent(id)}/reject`, comment ? { comment } : {});
  }
  commentApproval(id: string, body: string) {
    return this.call<{ comment: ApprovalComment }>("POST", `/approvals/${encodeURIComponent(id)}/comments`, { body });
  }
  revokeApprovalGrant(id: string) {
    return this.call<{ revoked: boolean; grantIds: string[] }>("POST", `/approvals/${encodeURIComponent(id)}/grant/revoke`);
  }
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** M2.3-b1 `cardView` (apps/api/src/approvals-routes.ts). */
export interface ApprovalCard {
  id: string;
  /** M2.3 gate name (e.g. "decision", "purge"); see apps/api/src/approvals.ts GATES. */
  gate: string;
  action: string;
  target: string;
  reason: string;
  consequence: string | null;
  /** Decimal string, e.g. "12.50". */
  costUsd: string | null;
  projectId: string | null;
  status: ApprovalStatus;
  createdAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

/** M2.3-b1 `grantView`: the newest live grant, else the newest. */
export interface ApprovalGrant {
  id: string;
  scopeAction: string;
  scopeResource: string | null;
  projectId: string | null;
  sha: string | null;
  expiresAt: string | null;
  maxUses: number;
  uses: number;
  revoked: boolean;
}

export interface ApprovalRow extends ApprovalCard {
  blockedTasks: number;
  grant: ApprovalGrant | null;
}

export interface ApprovalComment {
  id: string;
  author: string;
  body: string;
  createdAt: string | null;
}

export interface ApprovalDetail {
  approval: ApprovalCard;
  comments: ApprovalComment[];
  blockedTasks: { id: string; title: string; status: string }[];
  grant: ApprovalGrant | null;
}

/** DEVOS-77: a run job that failed for good (M1.5 dead-letter list). */
export interface DeadLetter {
  jobId: string;
  runId: string;
  reason: string;
  attemptsMade: number;
  failedAt: string | null;
}

export const SECRET_LABELS: Record<string, string> = {
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  github_token: "GitHub fine-grained token",
  linear_api_key: "Linear API key",
  r2_access_key_id: "Cloudflare R2 access key ID",
  r2_secret_access_key: "Cloudflare R2 secret access key",
  coolify_api_token: "Coolify API token",
  mybrain_bell_key: "MyBrain bell signing key (same value as in MyBrain)",
  smtp_password: "Email (SMTP) password",
};

/** Human messages for API codes; the code itself is shown too, never any input. */
export function explain(code: string): string {
  if (code === "api-unreachable") return "The DevOS API did not answer. Check you are on the tailnet.";
  if (code === "not-kk") return "This device is not signed in to the tailnet as KK.";
  if (code === "notifications-not-configured") return "Notifications need the database (DATABASE_URL).";
  if (code === "invalid:target-https-only") return "The MyBrain bell address must start with https://.";
  if (code === "invalid:target-host") return "The MyBrain bell address must be a public host name, not an IP address or localhost.";
  if (code === "dead-letters-not-configured") return "The failed-runs view needs the run queue (REDIS_URL) and the database.";
  if (code === "dead-letters-unavailable") return "The run queue did not answer. Try again in a minute.";
  if (code === "dead-letter-not-found") return "That run is no longer in the failed list (it may have been retried already).";
  if (code === "approvals-not-configured") return "Approvals need the database and the policy key on the server.";
  if (code === "approvals-store-error") return "The approvals store did not answer. Try again in a minute.";
  if (code === "card-not-found") return "That approval card no longer exists.";
  if (code === "card-not-pending") return "That card was already decided.";
  if (code === "invalid-input") return "Check the values you entered: whole numbers within the shown limits, and comments up to 2,000 characters.";
  if (code === "card-contains-secret") return "That text looks like a key or password, so it was not saved. Remove it and try again.";
  if (code === "purge-confirmation-mismatch") return "The typed phrase does not match. Type it exactly as shown.";
  if (code === "grant-not-found") return "There is no live grant on this card to revoke.";
  if (code === "vault-not-configured") return "The server vault key is not set yet (DEVOS_VAULT_KEY).";
  if (code.startsWith("invalid:value")) return "That value is not a valid key (16–4,096 characters, no spaces).";
  if (code.startsWith("invalid:") || code.startsWith("missing:")) return `Check the field: ${code.split(":")[1]}.`;
  return "Something went wrong.";
}
