// M2.2-d3b2 (docs/modules/M2.2.md, "M2.2-d3b2 — Behaviour"): the production model adapter for the analyst pass.
// One analyst call is one answer with no tools, so it is one Anthropic Messages API request. It is shaped as the
// Agent SDK's `query` stream, so M1.5's ClaudeAgentSdkAdapter (events, usage, cancel, error typing) runs it
// unchanged. No new dependency: Node's fetch, a bounded timeout, the key read from the vault by name at call time.
import type { CapabilityEnvelope } from "@devos/policy";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** Output-token cap of one answer: 32 000 × $10/MTok = $0.32, inside the run's $0.50 cap with the prompt. */
export const ANALYST_ANSWER_MAX_TOKENS = 32_000;
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

/** The opt-in switch `analyst.model_pass` (env `DEVOS_ANALYST_MODEL_PASS`): only `on` enables it. */
export function analystModelPass(env: NodeJS.ProcessEnv): boolean {
  return env.DEVOS_ANALYST_MODEL_PASS === "on";
}

/** Largest response body read (one 32 000-token answer is well under 1 MiB of JSON). */
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

type SdkMessage = { type: string; [k: string]: unknown };
type QueryArgs = { prompt: string; options: { abortController: AbortController; model: string; allowedTools?: string[] } };

export interface MessagesQueryOptions {
  /** Reads the key by name at call time (rotation applies at once); null → the call fails `analyst-key-missing`. */
  apiKey: () => Promise<string | null>;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * An Agent-SDK-shaped `query` over one Messages API request. No `tools` field is ever sent, so the model can only
 * answer in text (deny-all envelope, M2.2-d3b §1b); a non-empty allowedTools is refused before the request.
 */
export function messagesQuery(o: MessagesQueryOptions): (args: QueryArgs) => AsyncIterable<SdkMessage> {
  const doFetch = o.fetch ?? fetch;
  return async function* ({ prompt, options }: QueryArgs): AsyncGenerator<SdkMessage> {
    if (options.allowedTools && options.allowedTools.length > 0) throw new AnalystApiError("analyst-tools-refused");
    if (!ANTHROPIC_PRICES[options.model]) throw new AnalystApiError("analyst-model-unpriced");
    const key = await o.apiKey();
    if (!key) throw new AnalystApiError("analyst-key-missing");
    const signal = AbortSignal.any([options.abortController.signal, AbortSignal.timeout(o.timeoutMs)]);
    let res: Response;
    try {
      res = await doFetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: options.model, max_tokens: ANALYST_ANSWER_MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
        signal,
        redirect: "error",
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw name === "TimeoutError" ? Object.assign(new AnalystApiError("timeout"), { name: "TimeoutError" }) : e;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new AnalystApiError(`http-${res.status}`, res.status);
    }
    let body: { id?: unknown; model?: unknown; content?: unknown; usage?: Usage; stop_reason?: unknown };
    try {
      body = JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES)) as typeof body;
    } catch (e) {
      if (e instanceof AnalystApiError) throw e;
      throw new AnalystApiError("analyst-bad-response");
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.content)) throw new AnalystApiError("analyst-bad-response");
    const id = typeof body.id === "string" ? body.id : "";
    const usage = body.usage ?? {};
    // A tool_use block cannot occur without tools; if one did, it is dropped here, never forwarded as a call.
    const content = body.content.filter((b) => (b as { type?: unknown })?.type === "text");
    yield { type: "system", session_id: id };
    yield { type: "assistant", message: { content, usage, model: typeof body.model === "string" ? body.model : options.model } };
    const ok = body.stop_reason === "end_turn" || body.stop_reason === "stop_sequence";
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
