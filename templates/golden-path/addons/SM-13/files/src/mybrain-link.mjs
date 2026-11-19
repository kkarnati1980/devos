// SM-13-L1 (MyBrain link-out profile): the app is opened from MyBrain as a plain link, never inside a frame and
// never called cross-origin. Every response carries frame-ancestors 'none' (and X-Frame-Options: DENY for old
// browsers), and no response carries an Access-Control-Allow-* header, whatever a route sets. KK's login is the
// tailnet identity (SM-02); the app holds no MyBrain token.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { safeFetch } from "./safe-fetch.mjs";

export const LINK_OUT_HEADERS = Object.freeze({ "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" });
const CORS = /^access-control-/i;
const NONE = LINK_OUT_HEADERS["content-security-policy"];

// A route's own CSP values are kept untouched; `frame-ancestors 'none'` is added as a policy of its own. A browser
// enforces every policy, and framing needs every policy to allow it, so this one policy blocks it whatever the
// route's policies say (even a second policy hidden after a comma).
export function withFrameAncestorsNone(csp) {
  const values = (Array.isArray(csp) ? csp : csp === undefined || csp === null ? [] : [csp]).map(String).filter((v) => v.trim() && v.trim() !== NONE);
  return [...values, NONE];
}

function fixHeaderObject(h) {
  for (const name of Object.keys(h)) {
    if (CORS.test(name)) delete h[name];
    else if (name.toLowerCase() === "content-security-policy") h[name] = withFrameAncestorsNone(h[name]);
    else if (name.toLowerCase() === "x-frame-options") h[name] = "DENY";
  }
  return h;
}

function fixHeaderList(list) {   // writeHead's flat [name, value, name, value…] form
  if (list.length % 2) throw new TypeError("mybrain-link: a header list needs a value for every name");
  // Node applies a list through setHeader once a header is set (protectResponse sets them first), so a name
  // listed twice keeps only its last value: every CSP value of the list goes into one entry.
  const out = []; let csp = null;
  for (let i = 0; i < list.length; i += 2) {
    const name = String(list[i]); let value = list[i + 1];
    if (CORS.test(name)) continue;
    if (name.toLowerCase() === "x-frame-options") value = "DENY";
    if (name.toLowerCase() === "content-security-policy") { (csp ??= []).push(...(Array.isArray(value) ? value : [value])); continue; }
    out.push(name, value);
  }
  if (csp) out.push("content-security-policy", withFrameAncestorsNone(csp));
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
    res.setHeader("content-security-policy", withFrameAncestorsNone(res.getHeader("content-security-policy")));
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
  // Several CSP headers arrive joined by commas; each comma-separated part is one enforced policy. Framing is
  // blocked when at least one policy's first frame-ancestors directive is exactly 'none'.
  const blocks = (h["content-security-policy"] || "").split(",").some((policy) => {
    const fa = policy.split(";").map((d) => d.trim().replace(/\s+/g, " ").toLowerCase()).find((d) => /^frame-ancestors(\s|$)/.test(d));
    return fa === "frame-ancestors 'none'";
  });
  if (!blocks) out.push("frame-ancestors-not-none");
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
// Built from parts so this file does not match its own pattern.
const CREDENTIAL_NAME = new RegExp(["\\bMY_?BR", "AIN[\\w-]*?(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|SESSION)\\w*"].join(""), "i");
// node_modules and .git are skipped everywhere, the root test/ folder too (tests name fake credentials), and the
// files in `skipFiles` (the scan's own report). Links are not followed.
export function findMyBrainSecrets(root, { skipFiles = [] } = {}) {
  const skip = new Set(skipFiles.map((f) => resolve(f)));
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      if (name === "node_modules" || name === ".git" || rel === "test") continue;
      if (skip.has(resolve(full))) continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile() || st.size > 2_000_000) continue;
      const text = readFileSync(full, "utf8");
      const m = text.match(CREDENTIAL_NAME);
      if (m) out.push(`${rel}: names a MyBrain credential (${m[0].slice(0, 40)})`);
    }
  };
  walk(root);
  return out;
}
