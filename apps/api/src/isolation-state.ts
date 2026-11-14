// S4-a2b (docs/modules/S4.md, "S4-a2b decisions"): GET /internal/isolation-state, the document the host's
// isolation-apply.sh reads (S4 decision 4). It is served by its own small HTTP listener, never by the tailnet-facing
// Nest app. In the deployed container it binds the container's 0.0.0.0 and Compose publishes it on the host's
// 127.0.0.1 only; the host's connection then arrives from the container's default gateway (S4-a2b decision 1).
// It answers only:
//   - a caller that is neither loopback nor that gateway: 404, so it cannot tell the route exists (DEVOS-151);
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
/** One token pattern on both sides: isolation-apply.sh sends only these characters (S4-a2b decision 3). */
export const ISOLATION_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{32,512}$/;

export interface IsolationStateSource { listStacks(): Promise<IsolationStackRow[]> }

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The container's default IPv4 gateway from /proc/net/route text (the host's address on the Compose bridge), or
 * null. Docker's published-port path delivers the host's loopback connection from this address.
 */
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== "00000000" || !/^[0-9A-Fa-f]{8}$/.test(f[2]!) || f[2] === "00000000") continue;
    const n = parseInt(f[2]!, 16);
    // /proc/net/route stores the address little-endian.
    const ip = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
    return IPV4_RE.test(ip) ? ip : null;
  }
  return null;
}
const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Constant-time: both sides are hashed to 32 bytes first, so neither the length nor a prefix leaks. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = typeof header === "string" ? /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/.exec(header) : null;
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

export interface IsolationStateOptions {
  token: string;
  source: IsolationStateSource;
  /** Peers allowed besides loopback: only the container's default gateway (decision 1). */
  gateway?: string | null;
  onError?: (code: string) => void;
}

export function isolationStateHandler(opts: IsolationStateOptions) {
  if (typeof opts.token !== "string" || !ISOLATION_TOKEN_RE.test(opts.token)) throw new Error("config-isolation-state-token-invalid");
  if (opts.gateway != null && !IPV4_RE.test(opts.gateway)) throw new Error("config-isolation-state-gateway-invalid");
  const peers = new Set(opts.gateway ? [...LOOPBACK, opts.gateway, `::ffff:${opts.gateway}`] : LOOPBACK);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!peers.has(req.socket.remoteAddress ?? "")) return send(res, 404, { error: "not-found" });
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

export type IsolationBind = "127.0.0.1" | "0.0.0.0";

/**
 * Starts the listener on `bind` (127.0.0.1 by default; 0.0.0.0 only inside the container, where Compose publishes
 * the port on the host's 127.0.0.1 alone). The peer check still admits only loopback and the gateway.
 */
export function startIsolationStateServer(opts: IsolationStateOptions & { port?: number; bind?: IsolationBind }): Promise<Server> {
  const port = opts.port ?? DEFAULT_ISOLATION_STATE_PORT;
  const bind = opts.bind ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("config-isolation-state-port-invalid");
  if (bind !== "127.0.0.1" && bind !== "0.0.0.0") throw new Error("config-isolation-state-bind-invalid");
  const handler = isolationStateHandler(opts);
  const server = createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => { server.off("error", reject); resolve(server); });
  });
}

/**
 * Reads `DEVOS_ISOLATION_STATE_TOKEN` (the vault name `isolation_state_token`), `API_INTERNAL_PORT` and
 * `API_INTERNAL_BIND` by name.
 */
export function isolationStateConfig(env: NodeJS.ProcessEnv): { token: string; port: number; bind: IsolationBind } | null {
  const token = env.DEVOS_ISOLATION_STATE_TOKEN;
  if (token === undefined || token === "") return null;   // not installed yet: the listener stays off (fail closed)
  if (!ISOLATION_TOKEN_RE.test(token)) throw new Error("config-isolation-state-token-invalid");
  const port = Number(env.API_INTERNAL_PORT ?? DEFAULT_ISOLATION_STATE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("config-isolation-state-port-invalid");
  const bind = env.API_INTERNAL_BIND ?? "127.0.0.1";
  if (bind !== "127.0.0.1" && bind !== "0.0.0.0") throw new Error("config-isolation-state-bind-invalid");
  return { token, port, bind };
}

/** The gateway peer for the deployed container; null (loopback only) when the route table cannot be read. */
export function readDefaultGateway(read: () => string): string | null {
  try { return defaultGateway(read()); } catch { return null; }
}
