// S4-a2b (docs/modules/S4.md, "S4-a2b decisions"): GET /internal/isolation-state, the document the host's
// isolation-apply.sh reads (S4 decision 4). It is served by its own small HTTP listener bound to 127.0.0.1, never by
// the tailnet-facing Nest app, and answers only:
//   - a caller whose socket is not loopback: 404, so it cannot tell the route exists (S4-a2 decision, DEVOS-151);
//   - any other method or path: 404;
//   - a missing or wrong `Authorization: Bearer <isolation_state_token>`: 401 (constant-time compare);
//   - otherwise 200 with exactly {"stacks":[{slug, env, idx, egress, tailnet}]} from `stateDocument`, or 503 with a
//     fixed code when the store fails or the document would be refused (the host keeps its last good state).
// Egress and tailnet come from approved selections only (S4 decision 3). No approved selection carries them yet, so
// every stack gets the documented default: no egress, no tailnet (S4-a2b decision 2).
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stateDocument, type StackState } from "@devos/isolation";
import type { IsolationStackRow } from "./isolation-store.js";

export const ISOLATION_STATE_PATH = "/internal/isolation-state";
export const DEFAULT_ISOLATION_STATE_PORT = 3002;
/** The installer generates 32 random bytes; anything shorter is refused at start-up. */
export const MIN_ISOLATION_TOKEN_LENGTH = 32;

export interface IsolationStateSource { listStacks(): Promise<IsolationStackRow[]> }

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time: both sides are hashed to 32 bytes first, so neither the length nor a prefix leaks. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = typeof header === "string" ? /^Bearer ([\x21-\x7e]{1,512})$/.exec(header) : null;
  const given = digest(m ? m[1]! : "");
  return timingSafeEqual(given, digest(token)) && m !== null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

/** Builds the document from the store rows; egress and tailnet are the decision-3 defaults (S4-a2b decision 2). */
export async function buildIsolationState(source: IsolationStateSource): Promise<{ stacks: StackState[] }> {
  const rows = await source.listStacks();
  return stateDocument(rows.map((r) => ({ slug: r.slug, env: r.env, idx: r.idx, egress: false, tailnet: [] })));
}

export function isolationStateHandler(opts: { token: string; source: IsolationStateSource; onError?: (code: string) => void }) {
  if (typeof opts.token !== "string" || opts.token.length < MIN_ISOLATION_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(opts.token)) {
    throw new Error("config-isolation-state-token-invalid");
  }
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return send(res, 404, { error: "not-found" });
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "GET" || path !== ISOLATION_STATE_PATH) return send(res, 404, { error: "not-found" });
      if (!tokenMatches(req.headers.authorization, opts.token)) return send(res, 401, { error: "unauthorized" });
      let doc: { stacks: StackState[] };
      try {
        doc = await buildIsolationState(opts.source);
      } catch {
        // Never the store or validator message: a fixed code, and the host keeps its last good state.
        opts.onError?.("isolation-state-unavailable");
        return send(res, 503, { error: "isolation-state-unavailable" });
      }
      return send(res, 200, doc);
    } catch {
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.destroy();
    }
  };
}

/** Starts the loopback-only listener. The host is fixed to 127.0.0.1; only the port is configurable. */
export function startIsolationStateServer(opts: { token: string; source: IsolationStateSource; port?: number; onError?: (code: string) => void }): Promise<Server> {
  const port = opts.port ?? DEFAULT_ISOLATION_STATE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("config-isolation-state-port-invalid");
  const handler = isolationStateHandler(opts);
  const server = createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(server); });
  });
}

/** Reads `DEVOS_ISOLATION_STATE_TOKEN` (the vault name `isolation_state_token`) and `API_INTERNAL_PORT` by name. */
export function isolationStateConfig(env: NodeJS.ProcessEnv): { token: string; port: number } | null {
  const token = env.DEVOS_ISOLATION_STATE_TOKEN;
  if (token === undefined || token === "") return null;   // not installed yet: the listener stays off (fail closed)
  if (token.length < MIN_ISOLATION_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) throw new Error("config-isolation-state-token-invalid");
  const port = Number(env.API_INTERNAL_PORT ?? DEFAULT_ISOLATION_STATE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("config-isolation-state-port-invalid");
  return { token, port };
}
