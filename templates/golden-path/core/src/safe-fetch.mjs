// F2 Internal-URL block (DevOS build standard). The ONLY place in an app that may open an outbound HTTP
// connection; floor-check (F2-1) fails any other raw HTTP client.
// - http: and https: only; at most 5 redirects, each hop checked again;
// - the host is resolved once, every address is checked, and the socket is pinned to a checked address
//   (no second lookup, so DNS rebinding cannot swap it);
// - a timeout on the whole request and a cap on the response size.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";

export class SafeFetchError extends Error {
  constructor(code, message) { super(message); this.name = "SafeFetchError"; this.code = code; }
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];
const v4int = (ip) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const inV4 = (ip, [base, bits]) => bits === 0 || Math.floor(v4int(ip) / 2 ** (32 - bits)) === Math.floor(v4int(base) / 2 ** (32 - bits));

function v6words(ip) {  // full 8 x 16-bit words; an embedded dotted IPv4 tail is converted
  let s = ip.toLowerCase().split("%")[0];
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4int(m[2]); s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((w) => parseInt(w || "0", 16));
}

/** True when the address must never be reached from server-side code. */
export function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return V4_BLOCKED.some((r) => inV4(ip, r));
  if (fam !== 6) return true;   // not an IP: refuse
  const w = v6words(ip);
  if (w.length !== 8 || w.some((x) => Number.isNaN(x))) return true;
  const embedded = () => `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  if (w.slice(0, 7).every((x) => x === 0) && (w[7] === 0 || w[7] === 1)) return true;              // :: and ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isBlockedAddress(embedded());  // ::ffff:a.b.c.d
  if (w.slice(0, 6).every((x) => x === 0)) return isBlockedAddress(embedded());                    // ::a.b.c.d (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b) return isBlockedAddress(embedded());                       // NAT64 64:ff9b::/96
  if (w.slice(0, 4).every((x) => x === 0) && w[4] === 0xffff && w[5] === 0) return isBlockedAddress(embedded()); // SIIT ::ffff:0:a.b.c.d
  if (w[0] === 0x2002) return isBlockedAddress(`${w[1] >> 8}.${w[1] & 255}.${w[2] >> 8}.${w[2] & 255}`);         // 6to4 2002:aabb:ccdd::
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return true;                                       // 100::/64 discard
  if ((w[0] & 0xffc0) === 0xfec0) return true;    // fec0::/10 site-local (deprecated)
  if ((w[0] & 0xfe00) === 0xfc00) return true;    // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return true;    // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true;    // ff00::/8 multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;  // documentation
  return false;
}

async function resolveChecked(host, { lookup, allowed }) {
  const bare = host.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = net.isIP(bare) ? [{ address: bare, family: net.isIP(bare) }] : await lookup(bare); }
  catch (e) { throw new SafeFetchError("dns", `cannot resolve ${bare}: ${e && e.code ? e.code : "error"}`); }
  if (allowed) { if (!addrs.length) throw new SafeFetchError("dns", `no address for ${bare}`); return addrs[0]; }
  if (!addrs.length) throw new SafeFetchError("dns", `no address for ${bare}`);
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new SafeFetchError("blocked-address", `refused: ${bare} resolves to an internal address`);
  return addrs[0];
}

const defaultLookup = async (host) => dns.lookup(host, { all: true, verbatim: true });
// After a redirect to a different origin only these plain headers are kept; everything else (credentials under
// any name) is dropped.
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "accept-encoding", "user-agent", "content-type", "content-language", "cache-control", "pragma"]);
/** Headers to send on a redirect hop: credentials are dropped once the origin differs from the first one. */
export function redirectHeaders(headers, fromOrigin, toOrigin) {
  return fromOrigin === toOrigin ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => CROSS_ORIGIN_SAFE.has(k.toLowerCase())));
}
function checkAllowHosts(list) {
  return (list || []).map((h) => {
    const n = String(h).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(n) || net.isIP(n) || n === "localhost") {
      throw new SafeFetchError("allow-hosts", `allowHosts must name exact hostnames, not ${JSON.stringify(String(h))}`);
    }
    return n;
  });
}

/**
 * safeFetch(url, { method, headers, body, timeoutMs = 10000, maxBytes = 5_000_000, maxRedirects = 5,
 *                  allowHosts = [], lookup }) -> { status, headers, url, body: Buffer, text() }
 * allowHosts names exact hostnames that may be internal (declared services only). It applies to the URL the
 * caller passed and to redirects that never left that origin, so a public URL cannot bounce into a declared
 * service, and a declared service cannot be re-entered through a detour.
 * lookup is for tests. Every failure is a SafeFetchError with a code.
 */
export async function safeFetch(input, opts = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 10_000, maxBytes = 5_000_000, maxRedirects = 5 } = opts;
  const allowHosts = checkAllowHosts(opts.allowHosts);
  const lookup = opts.lookup || defaultLookup;
  const deadline = Date.now() + timeoutMs;
  let url;
  try { url = new URL(String(input)); } catch { throw new SafeFetchError("url", "invalid URL"); }   // normalises encoded IPv4
  const origin0 = url.origin;
  let m = String(method).toUpperCase(), b = body, h = { ...headers }, left0 = false;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("scheme", `refused scheme ${url.protocol}`);
    if (url.username || url.password) throw new SafeFetchError("credentials", "refused: credentials in URL");
    const left = deadline - Date.now();
    if (left <= 0) throw new SafeFetchError("timeout", "timed out");
    if (url.origin !== origin0) left0 = true;   // once a hop leaves the first origin, allowHosts never applies again
    const allowed = !left0 && allowHosts.includes(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
    const addr = await withTimeout(resolveChecked(url.hostname, { lookup, allowed }), left);
    const res = await request(url, addr, { method: m, headers: h, body: b, deadline, maxBytes });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw new SafeFetchError("redirects", "too many redirects");
      try { url = new URL(res.headers.location, url); } catch { throw new SafeFetchError("url", "invalid redirect location"); }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m !== "GET" && m !== "HEAD")) {
        m = "GET"; b = undefined;
        // The body is dropped, so its headers go too (Codex PR32-r1): a GET must not declare body bytes it never sends.
        h = Object.fromEntries(Object.entries(h).filter(([k]) => !/^(content-(length|type|encoding|language|location)|transfer-encoding)$/i.test(k)));
      }
      h = redirectHeaders(h, origin0, url.origin);
      continue;
    }
    return { ...res, url: url.href, text: () => res.body.toString("utf8") };
  }
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new SafeFetchError("timeout", "timed out")), ms); })])
    .finally(() => clearTimeout(t));
}

function request(url, addr, { method, headers, body, deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false, req;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); if (req) req.destroy(); reject(e); };
    const mod = url.protocol === "https:" ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // The socket connects to the checked address only; Host and SNI keep the original name.
    // agent:false: no keep-alive pool keyed by hostname and no environment proxy (NODE_USE_ENV_PROXY),
    // so the socket always goes to the address checked above and nothing resolves the name a second time.
    try { req = mod.request({
      agent: false,
      protocol: url.protocol, hostname: host, port: url.port || undefined, path: url.pathname + url.search, method, headers,
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
      servername: net.isIP(host) ? undefined : host,
    }, (res) => {
      const chunks = []; let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) return fail(new SafeFetchError("too-large", `response over ${maxBytes} bytes`));
        chunks.push(c);
      });
      res.on("end", () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on("error", () => fail(new SafeFetchError("network", "response failed")));
    }); } catch (e) { reject(new SafeFetchError("request", `invalid request: ${e && e.code ? e.code : "error"}`)); return; }
    const timer = setTimeout(() => fail(new SafeFetchError("timeout", "timed out")), Math.max(1, deadline - Date.now()));
    req.on("error", (e) => fail(e instanceof SafeFetchError ? e : new SafeFetchError("network", `request failed: ${e && e.code ? e.code : "error"}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
