// SM-02 add-on (access control, Lite): deny by default. Every app route sits behind one guard; only the core's
// /health and /ready are open. A caller is either KK's tailnet identity, sent by the local Tailscale proxy as
// `Tailscale-User-Login`, or a service with a bearer token. A route that takes an ID also checks the owner, so
// another owner's resource answers 404 (no IDOR). No dependencies.
//
//   const guard = createGuard({ tailnetLogins: ["kk@example.com"], serviceTokens: serviceTokensFromEnv() });
//   const routes = guard.protectAll({
//     "GET /notes": listNotes,
//     "GET /note": owned((req, ctx) => ownerOfNote(new URL(req.url, "http://app").searchParams.get("id")), getNote),
//   });
//   assertAllGuarded(routes);   // in an app test (SM-02-L1)
//
// Responses never echo what the caller sent (token, login or ID).
import crypto from "node:crypto";

// Markers are module-private, so a handler cannot claim to be guarded by setting a property.
const GUARDED = new WeakSet();
const OWNED = new WeakSet();
export const OPEN_ROUTES = Object.freeze(["GET /health", "GET /ready"]);
export const DEFAULT_TRUSTED_PROXIES = Object.freeze(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;
const LOGIN_SHAPE = /^[^\s,;]{1,254}$/;
const ENV_PREFIX = "SERVICE_TOKEN_SHA256_";

/** The SHA-256 hex digest of a token. The app stores digests, never the tokens themselves. */
export const tokenDigest = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

/** Reads `SERVICE_TOKEN_SHA256_<NAME>=<hex digest>` variables into { name: digest } (name lower-case, _ → -). */
export function serviceTokensFromEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(ENV_PREFIX)) continue;
    out[k.slice(ENV_PREFIX.length).toLowerCase().replaceAll("_", "-")] = String(v).trim().toLowerCase();
  }
  return out;
}

const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
};

export function createGuard({ tailnetLogins = [], serviceTokens = {}, trustedProxies = DEFAULT_TRUSTED_PROXIES } = {}) {
  if (!Array.isArray(tailnetLogins) || !Array.isArray(trustedProxies)) throw new Error("access: tailnetLogins and trustedProxies must be lists");
  const logins = new Set(tailnetLogins.map((l) => {
    if (typeof l !== "string" || !LOGIN_SHAPE.test(l)) throw new Error("access: bad tailnet login");
    return l.toLowerCase();
  }));
  const services = Object.entries(serviceTokens ?? {}).map(([name, digest]) => {
    if (!NAME_SHAPE.test(name)) throw new Error("access: bad service name");
    if (typeof digest !== "string" || !DIGEST_SHAPE.test(digest)) throw new Error(`access: service "${name}" needs a SHA-256 hex digest`);
    return { name, digest: Buffer.from(digest, "hex") };
  });
  if (!logins.size && !services.length) throw new Error("access: no callers configured (tailnetLogins or serviceTokens)");
  const proxies = new Set(trustedProxies);

  /** { caller } | { status: 401 | 403 } */
  function identify(req) {
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      // A bearer token was offered: it decides alone (no fall-back to the tailnet header).
      const m = /^Bearer ([^\s]+)$/.exec(String(auth));
      if (!m || !TOKEN_SHAPE.test(m[1])) return { status: 401 };
      const got = crypto.createHash("sha256").update(m[1], "utf8").digest();
      let match = null;
      for (const s of services) if (crypto.timingSafeEqual(got, s.digest) && !match) match = s; // compare all, no early exit
      return match ? { caller: Object.freeze({ id: `service:${match.name}`, kind: "service", name: match.name }) } : { status: 401 };
    }
    const login = req.headers["tailscale-user-login"];
    // The header is believed only from the local proxy; from anywhere else it is ignored (anyone can send it).
    if (login === undefined || !proxies.has(req.socket?.remoteAddress)) return { status: 401 };
    if (typeof login !== "string" || !LOGIN_SHAPE.test(login)) return { status: 401 };
    const l = login.toLowerCase();
    if (!logins.has(l)) return { status: 403 };
    return { caller: Object.freeze({ id: `tailnet:${l}`, kind: "tailnet", name: l }) };
  }

  function protect(handler) {
    if (typeof handler !== "function") throw new Error("access: handler must be a function");
    const wrapped = async (req, res, ctx = {}) => {
      const r = identify(req);
      if (!r.caller) {
        return r.status === 403 ? send(res, 403, { error: "forbidden" }) : send(res, 401, { error: "unauthenticated" }, { "www-authenticate": "Bearer" });
      }
      return handler(req, res, { ...ctx, caller: r.caller });
    };
    GUARDED.add(wrapped);
    if (OWNED.has(handler)) OWNED.add(wrapped);
    return wrapped;
  }

  function protectAll(routes) {
    const out = {};
    for (const [route, h] of Object.entries(routes)) {
      if (OPEN_ROUTES.includes(route)) throw new Error(`access: ${route} is a core open route`);
      out[route] = protect(h);
    }
    return out;
  }

  return { identify, protect, protectAll };
}

/**
 * For a route that takes an ID (SM-02-L2). `loadOwner(req, ctx)` returns the owner id of the resource the request
 * names (a caller id such as "tailnet:kk@example.com"), or null when there is none. A missing resource and another
 * owner's resource both answer 404, so a caller cannot tell them apart. Without a caller (route not guarded) it is 401.
 */
export function owned(loadOwner, handler) {
  if (typeof loadOwner !== "function" || typeof handler !== "function") throw new Error("access: owned(loadOwner, handler)");
  const wrapped = async (req, res, ctx = {}) => {
    if (!ctx.caller) return send(res, 401, { error: "unauthenticated" }, { "www-authenticate": "Bearer" });
    const owner = await loadOwner(req, ctx);
    if (owner == null || owner !== ctx.caller.id) return send(res, 404, { error: "not-found" });
    return handler(req, res, ctx);
  };
  OWNED.add(wrapped);
  return wrapped;
}

/** SM-02-L1 evidence (`route_list`): every route with whether it is open, guarded and owner-checked. */
export function routeInventory(routes) {
  return [
    ...OPEN_ROUTES.map((route) => ({ route, open: true, guarded: false, ownerChecked: false })),
    ...Object.entries(routes).map(([route, h]) => ({ route, open: false, guarded: GUARDED.has(h), ownerChecked: OWNED.has(h) })),
  ];
}

/** Throws, naming each route that is not behind the guard. */
export function assertAllGuarded(routes) {
  const bad = routeInventory(routes).filter((r) => !r.open && !r.guarded).map((r) => r.route);
  if (bad.length) throw new Error(`access: routes not behind the guard: ${bad.join(", ")}`);
}
