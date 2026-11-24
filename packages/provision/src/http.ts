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
    /**
     * DEVOS-21 part 5: on a 422, the field names a validation error lists (the keys of the body's `errors`
     * object), filtered to fixed lower-case names; never a value or a message.
     */
    public readonly fields?: readonly string[],
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
  /** DEVOS-21 part 3: the response headers of a 2xx answer (read-only; a caller reads a named header, never all). */
  headers?: { get(name: string): string | null };
}

export class Transport {
  readonly provider: string;
  /** Codex PR223-r13: read by the GitHub pagination readers to check a `rel=next` target's origin. */
  readonly origin: string;
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

  /**
   * A transport that uses one token snapshot, read now, for every request it makes (Codex PR44-r5): a check made
   * with it (e.g. "whose token is this?") and the write that depends on that check use the same credential, even if
   * the vault's token is replaced in between.
   */
  async pinned(): Promise<Transport> {
    const snap = await this.readToken();
    return new Transport({ provider: this.provider, origin: this.origin, ...this.o, token: () => snap });
  }

  private async readToken(): Promise<string> {
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
    return token;
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
    const token = await this.readToken();
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
      const fields = res.status === 422 ? await validationFields(res, sentKeys(body)) : (await res.body?.cancel().catch(() => {}), undefined);
      throw new ProviderError(this.provider, "http", `${this.provider} ${method} ${url.pathname} returned ${res.status}`, res.status, fields);
    }
    if (res.status === 204) return { status: 204, body: null, headers: res.headers };
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
    if (!text) return { status: res.status, body: null, headers: res.headers };
    try {
      return { status: res.status, body: JSON.parse(text) as T, headers: res.headers };
    } catch {
      throw new ProviderError(this.provider, "bad-response", `${this.provider} ${method} ${url.pathname} returned invalid JSON`, res.status);
    }
  }
}

const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_ERROR_BODY = 16_384;

/** Codex PR229-r1 #2: the top-level keys of the JSON body we sent; only these may be named as rejected fields. */
function sentKeys(body: unknown): ReadonlySet<string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Set();
  return new Set(Object.keys(body as Record<string, unknown>).filter((k) => FIELD_RE.test(k)));
}

/**
 * Codex PR229-r1 #1: reads at most `max` bytes of the body, then cancels the rest. Returns undefined when the body
 * is larger than `max` (it is never read whole) or the read fails.
 */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * DEVOS-21 part 5: the field names of a 422 validation answer (`{"errors": {"<field>": [...]}}`, the shape Coolify
 * and GitHub use), read under the request's own timeout signal and at most 16 KiB of it. Only names that are
 * top-level keys of the body we sent (Codex PR229-r1 #2) are kept (at most 5, sorted); the messages and values are
 * never read out. Any read or parse failure gives no fields.
 */
async function validationFields(res: Response, allowed: ReadonlySet<string>): Promise<readonly string[] | undefined> {
  try {
    // Pre-review: refuse a declared large body before reading it; the read itself is capped too (Codex PR229-r1 #1).
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (allowed.size === 0 || !Number.isFinite(declared) || declared > MAX_ERROR_BODY) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    const text = await readCapped(res, MAX_ERROR_BODY);
    if (text === undefined) return undefined;
    const body = JSON.parse(text) as { errors?: unknown };
    const errs = body && typeof body === "object" ? body.errors : undefined;
    if (!errs || typeof errs !== "object" || Array.isArray(errs)) return undefined;
    const names = Object.keys(errs).filter((k) => FIELD_RE.test(k) && allowed.has(k)).sort().slice(0, 5);
    return names.length ? names : undefined;
  } catch {
    return undefined;
  }
}
