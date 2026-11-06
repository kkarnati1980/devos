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

export class DevosApi {
  private csrf: string | null = null;
  constructor(private readonly origin: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
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

  /** Sign-in: a fresh 12-hour session for KK's tailnet identity; keeps the CSRF token in memory. */
  async signIn(): Promise<ApiResult<{ login: string; expiresAt: string }>> {
    const r = await this.call<{ login: string; expiresAt: string; csrfToken: string }>("POST", "/auth/session");
    if (!r.ok) return r;
    this.csrf = r.data.csrfToken;
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
  saveSettings(patch: Partial<Pick<SettingsView, "anthropicCapUsd" | "openaiCapUsd" | "defaultProjectCapUsd" | "defaultLanes" | "deadlockAttempts">>) {
    return this.call<{ settings: SettingsView }>("PUT", "/settings", patch);
  }
  secrets() {
    return this.call<{ secrets: SecretMeta[] }>("GET", "/vault/secrets");
  }
  saveSecret(name: string, value: string) {
    return this.call<{ secret: SecretMeta; rotated: boolean }>("PUT", `/vault/secrets/${encodeURIComponent(name)}`, { value });
  }
}

export const SECRET_LABELS: Record<string, string> = {
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  github_token: "GitHub fine-grained token",
  linear_api_key: "Linear API key",
  r2_access_key_id: "Cloudflare R2 access key ID",
  r2_secret_access_key: "Cloudflare R2 secret access key",
  coolify_api_token: "Coolify API token",
};

/** Human messages for API codes; the code itself is shown too, never any input. */
export function explain(code: string): string {
  if (code === "api-unreachable") return "The DevOS API did not answer. Check you are on the tailnet.";
  if (code === "not-kk") return "This device is not signed in to the tailnet as KK.";
  if (code === "vault-not-configured") return "The server vault key is not set yet (DEVOS_VAULT_KEY).";
  if (code.startsWith("invalid:value")) return "That value is not a valid key (16–4,096 characters, no spaces).";
  if (code.startsWith("invalid:") || code.startsWith("missing:")) return `Check the field: ${code.split(":")[1]}.`;
  return "Something went wrong.";
}
