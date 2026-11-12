// M2.4-a provider transport (docs/modules/M2.4.md, decisions 5 and 7).
// Fixed origin per provider, a timeout on every call (ADR-0011 §9). Only reads (GET) are retried, on
// network errors, timeouts, 429 and 5xx, with exponential backoff + jitter, at most `maxAttempts`.
// Writes are never retried here: the step runner looks the resource up again before any second create.
// The token is read through a callback at call time and never appears in a log line or an error message.

export type ErrorCode = "network" | "timeout" | "http" | "bad-response" | "no-token";

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Transient: worth retrying a read, and for a write it means "the create may or may not have happened". */
  get transient(): boolean {
    return this.code === "network" || this.code === "timeout" || (this.code === "http" && (this.status === 429 || (this.status ?? 0) >= 500));
  }
}

export interface TransportOptions {
  provider: string;
  /** `scheme://host[:port]` with no path; every request goes to this origin only. */
  origin: string;
  token: () => Promise<string> | string;
  /** Builds the auth header from the token. */
  authHeader?: (token: string) => Record<string, string>;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

export class Transport {
  readonly provider: string;
  private readonly origin: string;
  private readonly o: Required<Omit<TransportOptions, "provider" | "origin">>;

  constructor(opts: TransportOptions) {
    const u = new URL(opts.origin);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
      throw new Error(`transport-origin-invalid: ${opts.provider}`);
    }
    this.provider = opts.provider;
    this.origin = u.origin;
    this.o = {
      token: opts.token,
      authHeader: opts.authHeader ?? ((t) => ({ authorization: `Bearer ${t}` })),
      extraHeaders: opts.extraHeaders ?? {},
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxAttempts: opts.maxAttempts ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 500,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** GET; 404 is returned to the caller (a lookup miss), other non-2xx throw. Retried when transient. */
  async get<T>(path: string): Promise<HttpResult<T | null>> {
    let last: ProviderError | undefined;
    for (let i = 0; i < this.o.maxAttempts; i++) {
      try {
        return await this.once<T>("GET", path, undefined, true);
      } catch (e) {
        last = e as ProviderError;
        if (!(e instanceof ProviderError) || !e.transient || i === this.o.maxAttempts - 1) throw e;
        const backoff = this.o.baseDelayMs * 2 ** i;
        await this.o.sleep(backoff / 2 + Math.random() * (backoff / 2));
      }
    }
    throw last ?? new ProviderError(this.provider, "network", "request failed");
  }

  /** A write (POST/PUT/PATCH/DELETE): exactly one attempt. */
  async write<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<HttpResult<T>> {
    const r = await this.once<T>(method, path, body, false);
    return r as HttpResult<T>;
  }

  private async once<T>(method: string, path: string, body: unknown, allow404: boolean): Promise<HttpResult<T | null>> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`transport-path-invalid: ${this.provider}`);
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error(`transport-path-invalid: ${this.provider}`);
    let token: string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      token = await Promise.race([
        Promise.resolve(this.o.token()),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("token-timeout")), Math.min(this.o.timeoutMs, 10_000)); }),
      ]);
    } catch {
      throw new ProviderError(this.provider, "no-token", `${this.provider} token is not available from the vault`);
    } finally {
      clearTimeout(timer);
    }
    if (!token) throw new ProviderError(this.provider, "no-token", `${this.provider} token is not available from the vault`);
    let res: Response;
    try {
      res = await this.o.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...this.o.extraHeaders,
          ...this.o.authHeader(token),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError(this.provider, "timeout", `${this.provider} ${method} ${url.pathname} timed out`);
      }
      throw new ProviderError(this.provider, "network", `${this.provider} ${method} ${url.pathname} failed`);
    }
    if (allow404 && res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { status: 404, body: null };
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(this.provider, "http", `${this.provider} ${method} ${url.pathname} returned ${res.status}`, res.status);
    }
    if (res.status === 204) return { status: 204, body: null };
    // Codex PR44-r1: the body is read under the same timeout signal. A body that stalls or breaks is a transient
    // timeout/network error (a GET is retried; a write goes to the runner's lookup-before-recreate), never a raw error.
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError(this.provider, "timeout", `${this.provider} ${method} ${url.pathname} timed out reading the response`);
      }
      throw new ProviderError(this.provider, "network", `${this.provider} ${method} ${url.pathname} response could not be read`);
    }
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) as T };
    } catch {
      throw new ProviderError(this.provider, "bad-response", `${this.provider} ${method} ${url.pathname} returned invalid JSON`, res.status);
    }
  }
}
