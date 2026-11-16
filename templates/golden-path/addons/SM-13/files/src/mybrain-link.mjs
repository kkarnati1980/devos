// SM-13-L1 (MyBrain link-out profile): the app is opened from MyBrain as a plain link, never inside a frame and
// never called cross-origin. Every response carries frame-ancestors 'none' (and X-Frame-Options: DENY for old
// browsers), and no response carries an Access-Control-Allow-* header, whatever a route sets. KK's login is the
// tailnet identity (SM-02); the app holds no MyBrain token.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { safeFetch } from "./safe-fetch.mjs";

export const LINK_OUT_HEADERS = Object.freeze({ "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" });
const CORS = /^access-control-/i;
const FRAME_ANCESTORS = /(^|;)\s*frame-ancestors\b[^;]*/i;

// Keeps a route's own CSP and forces its frame-ancestors directive to 'none'.
export function lockFrameAncestors(csp) {
  const text = Array.isArray(csp) ? csp.join("; ") : csp === undefined || csp === null ? "" : String(csp);
  if (!text.trim()) return LINK_OUT_HEADERS["content-security-policy"];
  const rest = text.replace(new RegExp(FRAME_ANCESTORS.source, "gi"), "$1").split(";").map((d) => d.trim()).filter(Boolean);
  return [...rest, "frame-ancestors 'none'"].join("; ");
}

function fixHeaderObject(h) {
  for (const name of Object.keys(h)) {
    if (CORS.test(name)) delete h[name];
    else if (name.toLowerCase() === "content-security-policy") h[name] = lockFrameAncestors(h[name]);
    else if (name.toLowerCase() === "x-frame-options") h[name] = "DENY";
  }
  return h;
}

function fixHeaderList(list) {   // writeHead's flat [name, value, name, value…] form
  const out = [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    const name = String(list[i]); let value = list[i + 1];
    if (CORS.test(name)) continue;
    if (name.toLowerCase() === "content-security-policy") value = lockFrameAncestors(value);
    if (name.toLowerCase() === "x-frame-options") value = "DENY";
    out.push(name, value);
  }
  return out;
}

// Applies the profile to one response. Node calls writeHead for every response, including an implicit one from
// res.end(), so wrapping it covers every path, the core's /health, /ready and 404 included.
export function protectResponse(res) {
  if (res.__sm13) return res;
  res.__sm13 = true;
  for (const [k, v] of Object.entries(LINK_OUT_HEADERS)) res.setHeader(k, v);
  const writeHead = res.writeHead;
  res.writeHead = function (status, ...rest) {
    let i = typeof rest[0] === "string" ? 1 : 0;   // writeHead(status, [reason], [headers])
    if (rest[i] && typeof rest[i] === "object") rest[i] = Array.isArray(rest[i]) ? fixHeaderList(rest[i]) : fixHeaderObject({ ...rest[i] });
    for (const name of res.getHeaderNames()) if (CORS.test(name)) res.removeHeader(name);
    res.setHeader("content-security-policy", lockFrameAncestors(res.getHeader("content-security-policy")));
    res.setHeader("x-frame-options", "DENY");
    return writeHead.call(this, status, ...rest);
  };
  return res;
}

// Use on the server the core's createApp() returns: the profile runs before any route.
export function applyLinkOut(server) {
  if (!server || typeof server.prependListener !== "function") throw new TypeError("mybrain-link: pass the http server from createApp()");
  server.prependListener("request", (_req, res) => protectResponse(res));
  return server;
}

// Findings for one response's headers (names in any case).
export function headerFindings(headers) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
  const out = [];
  const fa = (h["content-security-policy"] || "").match(FRAME_ANCESTORS);
  if (!fa || fa[0].replace(/^;/, "").trim().replace(/\s+/g, " ").toLowerCase() !== "frame-ancestors 'none'") out.push("frame-ancestors-not-none");
  for (const k of Object.keys(h)) if (CORS.test(k)) out.push(`cors-header:${k}`);
  return out;
}

// SM-13-L1 scan: requests each path of a running app (GET, and an OPTIONS preflight from a foreign origin) and
// returns the scan_report record. `baseUrl` is the app's own address (a local address or its tailnet name),
// declared through safeFetch's allowHosts for this one host. No redirect is followed.
export async function scanApp({ baseUrl, paths = ["/health", "/ready", "/"], fetcher = safeFetch, now = () => new Date() }) {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol)) throw new TypeError("mybrain-link: baseUrl must be http(s)");
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === "string" && p.startsWith("/") && !p.startsWith("//"))) {
    throw new TypeError("mybrain-link: paths are absolute paths on the app");
  }
  // safeFetch declares internal hosts by name only, so an IP or localhost base is reached through a reserved
  // name that resolves to that one address and to nothing else.
  let host = base.hostname; let lookup;
  const bare = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":")) {
    const address = host === "localhost" ? "127.0.0.1" : bare;
    host = "app-under-scan.invalid";
    lookup = async (h) => {
      if (h === host) return [{ address, family: address.includes(":") ? 6 : 4 }];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
  }
  const target = new URL(base.href); target.hostname = host;
  const findings = []; const checked = [];
  for (const p of paths) {
    for (const method of ["GET", "OPTIONS"]) {
      const headers = method === "OPTIONS" ? { origin: "https://evil.example", "access-control-request-method": "POST" } : { origin: "https://evil.example" };
      let res;
      try {
        res = await fetcher(new URL(p, target).href, { method, headers, maxRedirects: 0, timeoutMs: 5000, maxBytes: 1_000_000, allowHosts: [host], ...(lookup ? { lookup } : {}) });
      } catch (e) { findings.push(`${method} ${p}: unreachable (${e.code || "error"})`); continue; }
      checked.push({ method, path: p, status: res.status });
      for (const f of headerFindings(res.headers)) findings.push(`${method} ${p}: ${f}`);
    }
  }
  return { check: "SM-13-L1", ok: findings.length === 0, findings, checked, time: now().toISOString() };
}

// "No MyBrain tokens in the app": a MyBrain credential named in code or config is a finding.
const MYBRAIN_SECRET = /\bMY_?BRAIN[\w-]*?(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|SESSION)\w*/i;
// node_modules and .git are skipped everywhere, the root test/ folder too (tests name fake credentials).
export function findMyBrainSecrets(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (name === "node_modules" || name === ".git" || rel === "test") continue;
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile() || st.size > 2_000_000) continue;
      const text = readFileSync(full, "utf8");
      const m = text.match(MYBRAIN_SECRET);
      if (m) out.push(`${rel}: names a MyBrain credential (${m[0].slice(0, 40)})`);
    }
  };
  walk(root);
  return out;
}
