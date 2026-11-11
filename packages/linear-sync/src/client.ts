// M2.6 Linear GraphQL client (docs/modules/M2.6.md). One POST endpoint, a timeout on every call (ADR-0011),
// retries only for reads (network error, 429, 5xx) with exponential backoff + jitter, at most 3 attempts.
// Mutations are never retried here: the sync re-reads by idempotency marker before creating again.
// The API key is read through a callback at call time and never logged or put in an error message.

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {
  constructor(public readonly code: "network" | "timeout" | "http" | "graphql" | "rate-limited" | "bad-response", message: string,
              public readonly status?: number, public readonly retryAfterMs?: number) {
    super(message);
    this.name = "LinearError";
  }
}

export interface LinearClientOptions {
  apiKey: () => Promise<string> | string;
  endpoint?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Below this many remaining requests, calls fail with rate-limited until the reset time. */
  minRemaining?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class LinearClient {
  private pausedUntil = 0;
  private readonly o: Required<Omit<LinearClientOptions, "apiKey">> & { apiKey: LinearClientOptions["apiKey"] };

  constructor(opts: LinearClientOptions) {
    this.o = {
      endpoint: LINEAR_ENDPOINT, timeoutMs: 15_000, maxAttempts: 3, baseDelayMs: 500, minRemaining: 50,
      fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), ...opts,
    };
  }

  /** A read (GraphQL query): retried on network errors, timeouts, 429 and 5xx. */
  query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(query, variables, true);
  }

  /** A write (GraphQL mutation): never retried; the caller re-reads before trying again. */
  mutate<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(query, variables, false);
  }

  private async call<T>(query: string, variables: Record<string, unknown>, retry: boolean): Promise<T> {
    const attempts = retry ? this.o.maxAttempts : 1;
    let last: LinearError | undefined;
    for (let i = 0; i < attempts; i++) {
      if (this.o.now() < this.pausedUntil) {
        throw new LinearError("rate-limited", "Linear rate limit headroom is low; paused", 429, this.pausedUntil - this.o.now());
      }
      try {
        return await this.once<T>(query, variables);
      } catch (e) {
        last = e instanceof LinearError ? e : new LinearError("network", "request failed");
        const transient = last.code === "network" || last.code === "timeout" || (last.code === "http" && (last.status === 429 || (last.status ?? 0) >= 500));
        if (!retry || !transient || i === attempts - 1) throw last;
        const backoff = this.o.baseDelayMs * 2 ** i;
        await this.o.sleep(Math.max(last.retryAfterMs ?? 0, backoff / 2 + Math.random() * backoff / 2));
      }
    }
    throw last ?? new LinearError("network", "request failed");
  }

  private async once<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let key: string;
    try { key = await this.o.apiKey(); } catch { throw new LinearError("bad-response", "Linear API key is not available from the vault"); }
    let res: Response;
    try {
      res = await this.o.fetchImpl(this.o.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new LinearError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", name === "TimeoutError" ? "Linear call timed out" : "Linear call failed");
    }
    const remaining = Number(res.headers.get("x-ratelimit-requests-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-requests-reset"));
    if (Number.isFinite(remaining) && res.headers.has("x-ratelimit-requests-remaining") && remaining < this.o.minRemaining) {
      this.pausedUntil = Number.isFinite(reset) && reset > this.o.now() ? reset : this.o.now() + 60_000;
    }
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      // Linear reports rate limiting as a GraphQL error code, possibly on a 4xx: read the code before deciding.
      let code: unknown;
      try { code = ((await res.json()) as { errors?: { extensions?: { code?: string } }[] })?.errors?.[0]?.extensions?.code; } catch { /* not JSON */ }
      const status = code === "RATELIMITED" ? 429 : res.status;
      const retryMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : undefined;   // bounded
      throw new LinearError("http", `Linear answered HTTP ${res.status}${code === "RATELIMITED" ? " (rate limited)" : ""}`, status, retryMs);
    }
    let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] };
    try { body = (await res.json()) as typeof body; } catch { throw new LinearError("bad-response", "Linear answered with invalid JSON"); }
    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code;
      if (code === "RATELIMITED") throw new LinearError("http", "Linear rate limited the request", 429);
      // Error text from Linear is data: keep it short and never echo variables (they may hold descriptions).
      throw new LinearError("graphql", `Linear GraphQL error${code ? ` (${String(code).slice(0, 40)})` : ""}`);
    }
    if (body.data === undefined) throw new LinearError("bad-response", "Linear answered without data");
    return body.data;
  }
}
