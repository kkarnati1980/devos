// SM-15 add-on: user-supplied URL fetching (docs/modules/S3.md, "S3-d2 SM-15 build notes").
// SM-15-L1: every case in the SSRF corpus is refused; oversized or slow responses are cut at the caps.
// A URL that a user typed or pasted goes through fetchUserUrl, never straight to safeFetch: it adds a stricter
// input check, tighter caps than safeFetch's defaults, GET/HEAD only, and never allowHosts (a user URL must
// never reach a declared internal service). Every address check is still safeFetch's (F2).
import { safeFetch, SafeFetchError } from "./safe-fetch.mjs";

/** The most a user URL fetch may use. A caller may lower each cap, never raise it. */
export const USER_URL_LIMITS = Object.freeze({ maxUrlLength: 2048, timeoutMs: 8_000, maxBytes: 2_000_000, maxRedirects: 3 });
const METHODS = new Set(["GET", "HEAD"]);

function cap(value, max, name) {
  if (value === undefined) return max;
  if (!Number.isInteger(value) || value < (name === "maxRedirects" ? 0 : 1) || value > max) {
    throw new TypeError(`fetchUserUrl: ${name} must be an integer up to ${max}`);
  }
  return value;
}

/** Parses what the user gave. Throws a SafeFetchError (code url, scheme or credentials); returns a URL. */
export function parseUserUrl(input) {
  if (typeof input !== "string") throw new SafeFetchError("url", "the URL must be text");
  const s = input.trim();
  if (!s) throw new SafeFetchError("url", "empty URL");
  if (s.length > USER_URL_LIMITS.maxUrlLength) throw new SafeFetchError("url", `URL longer than ${USER_URL_LIMITS.maxUrlLength} characters`);
  let url;
  try { url = new URL(s); } catch { throw new SafeFetchError("url", "invalid URL"); }   // absolute only: no base URL
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("scheme", `refused scheme ${url.protocol}`);
  if (url.username || url.password) throw new SafeFetchError("credentials", "refused: credentials in URL");
  if (!url.hostname) throw new SafeFetchError("url", "no host");
  // The parsed form can be much longer than what was typed (non-ASCII is percent-encoded); the cap holds for both.
  if (url.href.length > USER_URL_LIMITS.maxUrlLength) throw new SafeFetchError("url", `URL longer than ${USER_URL_LIMITS.maxUrlLength} characters once encoded`);
  return url;
}

/**
 * makeUserUrlFetcher({ transport }) -> fetchUserUrl. `transport` defaults to safeFetch; tests pass a wrapper that lets a
 * local stub stand in for a public server, the way the core safe-fetch tests do.
 * fetchUserUrl(input, { method = "GET", headers, timeoutMs, maxBytes, maxRedirects, lookup })
 *   -> safeFetch's result. Every failure is a SafeFetchError with a code; publicMessage(err) is what a user sees.
 */
export function makeUserUrlFetcher({ transport = safeFetch } = {}) {
  if (typeof transport !== "function") throw new TypeError("makeUserUrlFetcher: transport must be a function");
  return async function fetchUserUrl(input, opts = {}) {
    if (opts.allowHosts !== undefined) throw new TypeError("fetchUserUrl: allowHosts is not allowed for a user-supplied URL");
    if (opts.body !== undefined) throw new TypeError("fetchUserUrl: a user-supplied URL is fetched without a body");
    const method = String(opts.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new TypeError("fetchUserUrl: method must be GET or HEAD");
    const timeoutMs = cap(opts.timeoutMs, USER_URL_LIMITS.timeoutMs, "timeoutMs");
    const maxBytes = cap(opts.maxBytes, USER_URL_LIMITS.maxBytes, "maxBytes");
    const maxRedirects = cap(opts.maxRedirects, USER_URL_LIMITS.maxRedirects, "maxRedirects");
    const url = parseUserUrl(input);
    return transport(url.href, { method, headers: { ...(opts.headers || {}) }, timeoutMs, maxBytes, maxRedirects, allowHosts: [], lookup: opts.lookup });
  };
}

export const fetchUserUrl = makeUserUrlFetcher();

// What the user is told. "blocked-address" and "dns" get the same words, so the answer never tells a user whether
// an internal name exists; no message repeats the host or the resolver's error.
const MESSAGES = {
  url: "That is not a web address. Use a full link that starts with http:// or https://.",
  scheme: "That is not a web address. Use a full link that starts with http:// or https://.",
  credentials: "Links with a user name or password in them are not accepted.",
  "blocked-address": "That address cannot be fetched.",
  dns: "That address cannot be fetched.",
  timeout: "The site took too long to answer.",
  "too-large": "The page is too large to fetch.",
  redirects: "The link redirects too many times.",
};
export function publicMessage(err) {
  return (err instanceof SafeFetchError && Object.hasOwn(MESSAGES, err.code)) ? MESSAGES[err.code] : "The page could not be fetched.";
}
