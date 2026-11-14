// M2.2-d3b2 (docs/modules/M2.2.md, "M2.2-d3b2 — Behaviour"): the production model adapter for the analyst pass.
// One analyst call is one answer with no tools, so it is one Anthropic Messages API request. It is shaped as the
// Agent SDK's `query` stream, so M1.5's ClaudeAgentSdkAdapter (events, usage, cancel, error typing) runs it
// unchanged. No new dependency: Node's https client pinned to a checked address (F2, Codex PR92-r2), a bounded
// timeout, the key read from the vault by name at call time.
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { CapabilityEnvelope } from "@devos/policy";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Output-token cap of one answer (thinking included): 8 000 × $10/MTok = $0.08. Sized so a full answer can finish
 * inside the 90 s request deadline (pre-review finding 1); a longer answer stops `max_tokens` → assist-failed.
 */
export const ANALYST_ANSWER_MAX_TOKENS = 8_000;
/** Vault name of the Anthropic key (M1.4 SECRET_NAMES). */
export const ANTHROPIC_KEY_NAME = "anthropic_api_key";

/**
 * USD per million tokens, from Anthropic's published price list (Claude Sonnet 5.5, read 13 Nov 2026:
 * input $2, output $10, 5-minute cache write $2.50, cache read $0.10). A model without a price is refused
 * before any request, so the cost meter is never fed a guess.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function costUsd(model: string, u: Usage): number {
  const p = ANTHROPIC_PRICES[model];
  if (!p) throw new AnalystApiError("analyst-model-unpriced");
  return (n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + n(u.cache_creation_input_tokens) * p.cacheWrite + n(u.cache_read_input_tokens) * p.cacheRead) / 1_000_000;
}

/** A typed failure: `status` feeds the adapter's classify(); the message is a fixed code, never response text. */
export class AnalystApiError extends Error {
  constructor(code: string, readonly status?: number) {
    super(code);
    this.name = "AnalystApiError";
  }
}

/**
 * DEVOS-176: the model pass is switched on and off by the setting `analyst.model_pass` (M1.4 settings screen, default
 * off), read before each pass. The env `DEVOS_ANALYST_MODEL_PASS` is now only a hard off: exactly `off` keeps the run
 * engine unloaded, so the setting has no effect. Any other value (unset, `on`) leaves the decision to the setting.
 */
export function analystModelPassAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.DEVOS_ANALYST_MODEL_PASS !== "off";
}

/** Largest response body read (one 8 000-token answer is far under 1 MiB of JSON). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new AnalystApiError("analyst-response-too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- F2 internal-address block (Codex PR92-r2). Same address rules as the golden-path template's safeFetch
// (templates/golden-path/core/src/safe-fetch.mjs, DevOS's own code): the host is resolved once, every address is
// checked, and the socket is pinned to a checked address, so DNS rebinding cannot swap it. ----
const V4_BLOCKED: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];
const v4int = (ip: string): number => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const inV4 = (ip: string, [base, bits]: [string, number]): boolean =>
  bits === 0 || Math.floor(v4int(ip) / 2 ** (32 - bits)) === Math.floor(v4int(base) / 2 ** (32 - bits));
function v6words(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0] ?? "";
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const v = v4int(m[2] ?? ""); s = `${m[1] ?? ""}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`; }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((w) => parseInt(w || "0", 16));
}
/** True when server-side code must never connect to the address (private, loopback, link-local, reserved, …). */
export function isBlockedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return V4_BLOCKED.some((r) => inV4(ip, r));
  if (fam !== 6) return true;
  const words = v6words(ip);
  const w = (i: number): number => words[i] ?? 0;
  if (words.length !== 8 || words.some((x) => Number.isNaN(x))) return true;
  const embedded = (): string => `${w(6) >> 8}.${w(6) & 255}.${w(7) >> 8}.${w(7) & 255}`;
  if (words.slice(0, 7).every((x) => x === 0) && (w(7) === 0 || w(7) === 1)) return true;
  if (words.slice(0, 5).every((x) => x === 0) && w(5) === 0xffff) return isBlockedAddress(embedded());
  if (words.slice(0, 6).every((x) => x === 0)) return isBlockedAddress(embedded());
  if (w(0) === 0x64 && w(1) === 0xff9b) return isBlockedAddress(embedded());
  if (words.slice(0, 4).every((x) => x === 0) && w(4) === 0xffff && w(5) === 0) return isBlockedAddress(embedded());
  if (w(0) === 0x2002) return isBlockedAddress(`${w(1) >> 8}.${w(1) & 255}.${w(2) >> 8}.${w(2) & 255}`);
  if (w(0) === 0x0100 && words.slice(1, 4).every((x) => x === 0)) return true;
  if ((w(0) & 0xffc0) === 0xfec0) return true;
  if ((w(0) & 0xfe00) === 0xfc00) return true;
  if ((w(0) & 0xffc0) === 0xfe80) return true;
  if ((w(0) & 0xff00) === 0xff00) return true;
  if (w(0) === 0x2001 && w(1) === 0x0db8) return true;
  return false;
}

/**
 * Errors `pinnedFetch` raised before any request existed (the DNS lookup failed or was aborted, or the signal fired
 * before dispatch). Nothing reached the provider, so `messagesQuery` charges nothing for them (Codex PR92-r3, 2).
 * A WeakSet, so the caller's own abort reason is marked without being changed (AT-CA7 keeps `e === reason`).
 */
const preSendErrors = new WeakSet<object>();
function preSend<T>(e: T): T {
  if (e !== null && (typeof e === "object" || typeof e === "function")) preSendErrors.add(e as object);
  return e;
}
/** True for an error `pinnedFetch` raised before dispatch (no request was sent). */
export const isPreSendError = (e: unknown): boolean => e !== null && typeof e === "object" && preSendErrors.has(e);

/** Statuses whose Response must have a null body (the constructor throws otherwise; Codex PR92-r3, 1). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * The fetch Response for one upstream reply. A status outside 200–599 becomes 502; a null-body status (204, 205, …)
 * gets a null body and its stream is drained, because `new Response(stream, { status: 204 })` throws.
 */
export function toResponse(res: Readable, status: number): Response {
  const mapped = status < 200 || status > 599 ? 502 : status;
  if (NULL_BODY_STATUSES.has(mapped)) {
    res.resume();
    return new Response(null, { status: mapped });
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: mapped });
}

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * A fetch for the one Messages API call that never reaches an internal address (F2): https only; the host is
 * resolved once and refused (`analyst-blocked-address`, before anything is sent) if any address is internal; the
 * socket connects only to the checked address (Host and SNI keep the name); no keep-alive pool or env proxy
 * (`agent: false`); a redirect is refused like `redirect: "error"`; the caller's signal aborts the lookup, the
 * request and the body stream with the signal's reason, so the timeout and the engine's cancel keep working.
 */
export function pinnedFetch(lookup: Lookup = systemLookup): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (url.protocol !== "https:") throw new AnalystApiError("analyst-blocked-address");
    const signal = init.signal ?? undefined;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addrs: Array<{ address: string; family: number }>;
    try {
      addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await abortable(lookup(host), signal);
    } catch (e) {
      if (signal?.aborted) throw preSend(signal.reason);
      throw preSend(Object.assign(new TypeError("fetch failed"), { cause: e }));
    }
    if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) throw new AnalystApiError("analyst-blocked-address");
    const addr = addrs[0]!;
    if (signal?.aborted) throw preSend(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const req = https.request(
        {
          agent: false,
          hostname: host,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers: init.headers as Record<string, string>,
          servername: net.isIP(host) ? undefined : host,
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
            o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)) as unknown as net.LookupFunction,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            reject(new TypeError("fetch failed: redirect refused"));
            return;
          }
          settled = true;
          // Never throw inside this callback: it runs outside the Promise executor, so a throw here would crash the
          // process (Codex PR92-r3, 1). A null-body status gets a null body; anything else that fails rejects.
          try {
            resolve(toResponse(res, status));
          } catch (e) {
            res.destroy();
            reject(Object.assign(new TypeError("fetch failed"), { cause: e }));
          }
        },
      );
      const onAbort = (): void => {
        req.destroy(signal!.reason);
        if (!settled) { settled = true; reject(signal!.reason); }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => setImmediate(() => signal?.removeEventListener("abort", onAbort)));
      req.on("error", (e) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.aborted ? signal.reason : Object.assign(new TypeError("fetch failed"), { cause: e }));
      });
      try {
        if (typeof init.body === "string") req.write(init.body);
        req.end();
      } catch (e) {
        req.destroy();
        if (!settled) { settled = true; reject(Object.assign(new TypeError("fetch failed"), { cause: e })); }
      }
    });
  }) as typeof fetch;
}

const isTimeout = (e: unknown): boolean => (e as { name?: string })?.name === "TimeoutError";
const isAbort = (e: unknown): boolean => isTimeout(e) || (e as { name?: string })?.name === "AbortError";

type SdkMessage = { type: string; [k: string]: unknown };
type QueryArgs = { prompt: string; options: { abortController: AbortController; model: string; allowedTools?: string[] } };

export interface MessagesQueryOptions {
  /** Reads the key by name at call time (rotation applies at once); null → the call fails `analyst-key-missing`. */
  apiKey: () => Promise<string | null>;
  timeoutMs: number;
  /** Tests only; production uses `pinnedFetch` (F2, Codex PR92-r2). */
  fetch?: typeof fetch;
  /** Tests only: the resolver `pinnedFetch` checks. */
  lookup?: Lookup;
}

/**
 * An Agent-SDK-shaped `query` over one Messages API request. No `tools` field is ever sent, so the model can only
 * answer in text (deny-all envelope, M2.2-d3b §1b); a non-empty allowedTools is refused before the request.
 */
export function messagesQuery(o: MessagesQueryOptions): (args: QueryArgs) => AsyncIterable<SdkMessage> {
  const doFetch = o.fetch ?? pinnedFetch(o.lookup);
  return async function* ({ prompt, options }: QueryArgs): AsyncGenerator<SdkMessage> {
    if (options.allowedTools && options.allowedTools.length > 0) throw new AnalystApiError("analyst-tools-refused");
    if (!ANTHROPIC_PRICES[options.model]) throw new AnalystApiError("analyst-model-unpriced");
    const key = await o.apiKey();
    if (!key) throw new AnalystApiError("analyst-key-missing");
    const signal = AbortSignal.any([options.abortController.signal, AbortSignal.timeout(o.timeoutMs)]);
    const requestBody = JSON.stringify({ model: options.model, max_tokens: ANALYST_ANSWER_MAX_TOKENS, messages: [{ role: "user", content: prompt }] });
    let body: { id?: unknown; model?: unknown; content?: unknown; usage?: Usage; stop_reason?: unknown };
    // Cancelled before anything was sent: nothing to charge (round 2, finding 4).
    if (signal.aborted) throw isTimeout(signal.reason) ? Object.assign(new AnalystApiError("timeout"), { name: "TimeoutError" }) : new AnalystApiError("cancelled");
    try {
      const res = await doFetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        body: requestBody,
        signal,
        redirect: "error",
      });
      if (!res.ok) {
        // An error reply carries no answer and is not billed: no usage, no charge. Its body is never read.
        await res.body?.cancel().catch(() => undefined);
        throw new AnalystApiError(`http-${res.status}`, res.status);
      }
      try {
        body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)) as typeof body;
        if (!body || typeof body !== "object" || !Array.isArray(body.content)) throw new AnalystApiError("analyst-bad-response");
        // A billed reply always reports its token counts; without them the cost would be a $0 guess (round 2, finding 3).
        const u = body.usage as Usage | undefined;
        if (typeof u?.input_tokens !== "number" || typeof u?.output_tokens !== "number") throw new AnalystApiError("analyst-bad-response");
      } catch (e) {
        if (e instanceof AnalystApiError || isAbort(e)) throw e;
        throw new AnalystApiError("analyst-bad-response");
      }
    } catch (e) {
      if (e instanceof AnalystApiError && e.status !== undefined) throw e;
      // Refused before any byte was sent (F2): nothing to charge.
      if (e instanceof AnalystApiError && e.message === "analyst-blocked-address") throw e;
      // Failed before dispatch (DNS failure, or a timeout/cancel during the lookup): no provider request exists, so
      // nothing is charged (§5, AT-CA5; Codex PR92-r3, 2). Typed like the pre-send check above.
      if (isPreSendError(e)) {
        if (isTimeout(e)) throw Object.assign(new AnalystApiError("timeout"), { name: "TimeoutError" });
        if (isAbort(e) || signal.aborted) throw new AnalystApiError("cancelled");
        throw e;
      }
      // Pre-review finding 1: the request was sent, so the provider may bill a generation we never read (timeout,
      // cancel, a lost connection, an oversize or unreadable body). Report the upper bound of its tokens (every
      // request byte as an input token, the full answer cap as output) with no cost, so M1.5 settles fail-closed:
      // it charges the run's reservation instead of $0 (ADR-0006). Then the typed error ends the run.
      yield {
        type: "assistant",
        message: { content: [], model: options.model, usage: { input_tokens: Buffer.byteLength(requestBody, "utf8"), output_tokens: ANALYST_ANSWER_MAX_TOKENS } },
      };
      throw isTimeout(e) ? Object.assign(new AnalystApiError("timeout"), { name: "TimeoutError" }) : e;
    }
    const id = typeof body.id === "string" ? body.id : "";
    const usage = body.usage ?? {};
    // A tool_use block cannot occur without tools; if one did, it is dropped here, never forwarded as a call.
    const ok = body.stop_reason === "end_turn" || body.stop_reason === "stop_sequence";
    // A failed stop (e.g. max_tokens) keeps its usage, so its cost is metered, but none of its text (§6; round 2, 2).
    const content = ok ? (body.content as unknown[]).filter((b) => (b as { type?: unknown })?.type === "text") : [];
    yield { type: "system", session_id: id };
    yield { type: "assistant", message: { content, usage, model: typeof body.model === "string" ? body.model : options.model } };
    yield {
      type: "result",
      subtype: ok ? "success" : `stop-${String(body.stop_reason)}`,
      is_error: !ok,
      total_cost_usd: costUsd(options.model, usage),
    };
  };
}

/** The part of `@devos/run-engine` this module builds on (imported at run time, like @devos/db). */
export interface RunEngineModule {
  RunEngine: new (o: { store: unknown; policy: unknown; adapterFor: (provider: string) => unknown }) => {
    execute(input: { runId: string; provider: "anthropic"; prompt: string; cwd: string; tag?: string }): Promise<{ status: string }>;
  };
  PrismaRunStore: new (db: unknown) => unknown;
  ClaudeAgentSdkAdapter: new (o: { query: unknown; toolGate?: (tool: string, input: Record<string, unknown>) => Promise<boolean> }) => unknown;
}

/**
 * M1.5's RunEngine over this database and the M1.7 policy engine, with the analyst adapter for `anthropic`. Every
 * tool call is refused through the tool gate as well (the SDK's allowedTools only pre-approves). Any other
 * provider is refused: the analyst only runs Anthropic.
 */
export function buildAnalystEngine(m: RunEngineModule, db: unknown, policy: unknown, q: MessagesQueryOptions) {
  return new m.RunEngine({
    store: new m.PrismaRunStore(db),
    policy,
    adapterFor: (provider) => {
      if (provider !== "anthropic") throw new AnalystApiError("analyst-provider-refused");
      return new m.ClaudeAgentSdkAdapter({ query: messagesQuery(q), toolGate: async () => false });
    },
  });
}

/** Re-exported so tests can check the envelope the adapter is handed stays deny-all. */
export type { CapabilityEnvelope };
