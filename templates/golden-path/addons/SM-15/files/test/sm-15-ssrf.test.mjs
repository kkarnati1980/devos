// SM-15-L1: the full SSRF corpus (on top of F2-2) is refused for a user-supplied URL; oversized or slow responses
// are cut at the caps. Nothing here leaves the machine: every refused case stops before a socket opens, and the
// cases that do connect use a local stub that stands in for a public server (the core tests' approach).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SafeFetchError, safeFetch } from "../src/safe-fetch.mjs";
import { fetchUserUrl, makeUserUrlFetcher, parseUserUrl, publicMessage, USER_URL_LIMITS } from "../src/user-url.mjs";

let srv, port;
const timers = new Set();
before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === "/ok") { res.end("hello"); return; }
    if (req.url === "/big") { res.end(Buffer.alloc(4096, 97)); return; }
    if (req.url === "/big-chunked") { res.write(Buffer.alloc(3000, 97)); res.end(Buffer.alloc(3000, 97)); return; }   // no content-length
    if (req.url === "/no-answer") return;                                                                               // headers never come
    if (req.url === "/drip") {                                                                                          // one byte every 50 ms, forever
      res.writeHead(200);
      const t = setInterval(() => res.write("a"), 50); timers.add(t);
      res.on("close", () => { clearInterval(t); timers.delete(t); });
      return;
    }
    const hop = req.url.match(/^\/hop\/(\d+)$/);
    if (hop) { const n = Number(hop[1]); res.writeHead(302, { location: n > 0 ? `/hop/${n - 1}` : "/ok" }); res.end(); return; }
    const to = { "/to-metadata": "http://169.254.169.254/latest/meta-data/", "/to-loopback-v6": "http://[::1]/",
      "/to-decimal": "http://2130706433/", "/to-internal-name": "http://internal.test/", "/to-file": "file:///etc/passwd",
      "/to-gopher": "gopher://127.0.0.1:6379/_INFO", "/to-mapped": "http://[::ffff:10.0.0.1]/" }[req.url];
    if (to) { res.writeHead(302, { location: to }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  srv.on("connection", (s) => s.unref());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(() => { for (const t of timers) clearInterval(t); srv.closeAllConnections(); srv.close(); });

// Names the resolver answers in these tests. Any other name fails to resolve, so no case here can open a socket
// to a real address even if a check regressed (the case would then fail with "dns").
const NAMES = {
  "localhost": ["127.0.0.1"], "localhost.": ["127.0.0.1"], "internal.test": ["10.1.2.3"], "metadata.google.internal": ["169.254.169.254"],
  "mixed.test": ["93.184.216.34", "192.168.1.5"], "v6ula.test": ["fd00::1"], "v6mapped.test": ["::ffff:127.0.0.1"],
  "nip.test": ["127.0.0.1"], "aws6.test": ["fd00:ec2::254"],
};
const lookup = async (h) => { if (!NAMES[h]) { const e = new Error("not found"); e.code = "ENOTFOUND"; throw e; }
  return NAMES[h].map((address) => ({ address, family: address.includes(":") ? 6 : 4 })); };

// The stub stands in for a public server: "public.test" reaches it only through this test wrapper, the one bypass.
const viaStub = (url, o) => safeFetch(url, { ...o, allowHosts: ["public.test"], lookup: async (h) => (h === "public.test" ? [{ address: "127.0.0.1", family: 4 }] : lookup(h)) });
const stubFetch = makeUserUrlFetcher({ transport: viaStub });
const pub = (path) => `http://public.test:${port}${path}`;

const refusedBy = async (f, url, codes) => assert.rejects(f(url, { lookup }), (e) => {
  assert.ok(e instanceof SafeFetchError, `${url}: ${e}`);
  assert.ok([].concat(codes).includes(e.code), `${url}: got ${e.code} (${e.message})`);
  return true;
});
const refused = (url, codes = "blocked-address") => refusedBy(fetchUserUrl, url, codes);

// [url, the code it must be refused with]
const CORPUS = [
  // loopback, unspecified, private ranges, CGNAT, cloud metadata
  ["http://127.0.0.1/", "blocked-address"], ["http://127.1/", "blocked-address"], ["http://127.0.1/", "blocked-address"],
  ["http://0.0.0.0/", "blocked-address"], ["http://0/", "blocked-address"],
  ["http://10.0.0.1/", "blocked-address"], ["http://172.16.0.1/", "blocked-address"], ["http://172.31.255.255/", "blocked-address"],
  ["http://192.168.0.1/", "blocked-address"], ["http://100.64.0.1/", "blocked-address"], ["http://172.17.0.1:2375/", "blocked-address"],
  ["http://169.254.169.254/latest/meta-data/", "blocked-address"], ["http://[fd00:ec2::254]/", "blocked-address"],
  // encoded IPv4 (the URL parser turns them into dotted form; safeFetch checks that)
  ["http://2130706433/", "blocked-address"], ["http://0x7f000001/", "blocked-address"], ["http://0x7f.0.0.1/", "blocked-address"],
  ["http://0177.0.0.1/", "blocked-address"], ["http://017700000001/", "blocked-address"], ["http://0x7f.1/", "blocked-address"],
  ["http://%31%32%37.0.0.1/", "blocked-address"], ["http://１２７.0.0.1/", "blocked-address"],   // percent-encoded, full-width digits
  ["http://169.254.43518/", "blocked-address"], ["http://2852039166/", "blocked-address"],                     // metadata, short and decimal forms
  // IPv6 literals: loopback, unspecified, ULA, link-local, multicast, and every form that embeds an internal IPv4
  ["http://[::1]/", "blocked-address"], ["http://[::]/", "blocked-address"], ["http://[0:0:0:0:0:0:0:1]/", "blocked-address"],
  ["http://[fd00::1]/", "blocked-address"], ["http://[fe80::1]/", "blocked-address"], ["http://[ff02::1]/", "blocked-address"],
  ["http://[::ffff:127.0.0.1]/", "blocked-address"], ["http://[::ffff:7f00:1]/", "blocked-address"], ["http://[::ffff:a9fe:a9fe]/", "blocked-address"],
  ["http://[::127.0.0.1]/", "blocked-address"], ["http://[64:ff9b::a9fe:a9fe]/", "blocked-address"], ["http://[2002:7f00:1::]/", "blocked-address"],
  ["http://[::ffff:0:10.0.0.1]/", "blocked-address"], ["http://[fec0::1]/", "blocked-address"],
  // names: localhost, trailing dot, internal names, a name with any internal address, IPv6 answers
  ["http://localhost/", "blocked-address"], ["http://localhost.:8080/", "blocked-address"], ["http://LOCALHOST/", "blocked-address"],
  ["http://internal.test/", "blocked-address"], ["http://metadata.google.internal/computeMetadata/v1/", "blocked-address"],
  ["http://mixed.test/", "blocked-address"], ["http://v6ula.test/", "blocked-address"], ["http://v6mapped.test/", "blocked-address"],
  ["http://nip.test/", "blocked-address"], ["http://aws6.test/", "blocked-address"],
  // schemes other than http and https
  ["file:///etc/passwd", "scheme"], ["file://localhost/etc/passwd", "scheme"], ["gopher://127.0.0.1:6379/_INFO", "scheme"],
  ["ftp://example.com/", "scheme"], ["dict://127.0.0.1:11211/stats", "scheme"], ["ldap://127.0.0.1/", "scheme"],
  ["data:text/plain,hi", "scheme"], ["javascript:alert(1)", "scheme"], ["ws://example.com/", "scheme"],
  // credentials, and the user@host trick
  ["http://user:pass@example.com/", "credentials"], ["http://example.com@127.0.0.1/", "credentials"],
  // not a URL at all
  ["", "url"], ["   ", "url"], ["/relative/path", "url"], ["example.com", "url"], ["http://", "url"], ["http://[::1/", "url"],
];

test("SM-15-L1 corpus: every internal address, encoded form, name, scheme and credential case is refused", async () => {
  for (const [url, code] of CORPUS) await refused(url, code);
});

test("SM-15-L1 corpus: a redirect from a public page to any internal target or other scheme is refused", async () => {
  for (const path of ["/to-metadata", "/to-loopback-v6", "/to-decimal", "/to-internal-name", "/to-mapped"]) await refusedBy(stubFetch, pub(path), "blocked-address");
  for (const path of ["/to-file", "/to-gopher"]) await refusedBy(stubFetch, pub(path), "scheme");
  await refusedBy(stubFetch, pub(`/hop/${USER_URL_LIMITS.maxRedirects}`), "redirects");                // one hop too many
  const ok = await stubFetch(pub(`/hop/${USER_URL_LIMITS.maxRedirects - 1}`));                         // the most allowed
  assert.equal(ok.status, 200); assert.equal(ok.text(), "hello");
});

test("SM-15-L1 corpus: DNS rebinding: one lookup per request and per hop, and a name with any internal answer is refused", async () => {
  // The resolver answers the stub's address once, then an internal one: a second lookup for the connection would
  // have gone to 10.9.9.9 and failed.
  let seen = 0;
  const rebinding = makeUserUrlFetcher({ transport: (url, o) => safeFetch(url, { ...o, allowHosts: ["public.test"],
    lookup: async () => [{ address: ++seen === 1 ? "127.0.0.1" : "10.9.9.9", family: 4 }] }) });
  const r = await rebinding(pub("/ok"), { timeoutMs: 2000 });
  assert.equal(r.status, 200); assert.equal(r.text(), "hello");
  assert.equal(seen, 1, "one lookup, and the socket used its answer");
  // Over redirects: one lookup per hop, never more.
  let perHop = 0;
  const counting = makeUserUrlFetcher({ transport: (url, o) => safeFetch(url, { ...o, allowHosts: ["public.test"],
    lookup: async () => { perHop++; return [{ address: "127.0.0.1", family: 4 }]; } }) });
  assert.equal((await counting(pub("/hop/1"))).status, 200);   // /hop/1 -> /hop/0 -> /ok
  assert.equal(perHop, 3, "one lookup per hop");
  // A name with any internal answer is refused outright, whichever answer comes first.
  await refused("http://mixed.test/");
});

test("SM-15-L1 caps: oversized and slow responses are cut", async () => {
  await assert.rejects(stubFetch(pub("/big"), { maxBytes: 1024 }), (e) => e.code === "too-large");
  await assert.rejects(stubFetch(pub("/big-chunked"), { maxBytes: 4096 }), (e) => e.code === "too-large");
  let t0 = Date.now();
  await assert.rejects(stubFetch(pub("/no-answer"), { timeoutMs: 300 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 2000, "no-answer cut near the cap");
  t0 = Date.now();
  await assert.rejects(stubFetch(pub("/drip"), { timeoutMs: 300 }), (e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 2000, "a slow drip is cut at the cap, not at the first byte");
  const r = await stubFetch(pub("/ok"));
  assert.equal(r.text(), "hello", "a normal page passes under the caps");
});

test("SM-15-L1 caps: a caller may lower each cap but never raise it; the defaults are the limits", async () => {
  const calls = [];
  const spy = makeUserUrlFetcher({ transport: async (url, o) => { calls.push({ url, o }); return { status: 200 }; } });
  await spy("https://example.com/a?b=1", { headers: { accept: "text/html" } });
  assert.deepEqual(calls[0], { url: "https://example.com/a?b=1", o: { method: "GET", headers: { accept: "text/html" },
    timeoutMs: USER_URL_LIMITS.timeoutMs, maxBytes: USER_URL_LIMITS.maxBytes, maxRedirects: USER_URL_LIMITS.maxRedirects, allowHosts: [], lookup: undefined } });
  await spy("https://example.com/", { timeoutMs: 100, maxBytes: 10, maxRedirects: 0, method: "head" });
  assert.deepEqual([calls[1].o.timeoutMs, calls[1].o.maxBytes, calls[1].o.maxRedirects, calls[1].o.method], [100, 10, 0, "HEAD"]);
  for (const bad of [{ timeoutMs: USER_URL_LIMITS.timeoutMs + 1 }, { maxBytes: USER_URL_LIMITS.maxBytes + 1 }, { maxRedirects: USER_URL_LIMITS.maxRedirects + 1 },
    { timeoutMs: 0 }, { maxBytes: 1.5 }, { maxRedirects: -1 }, { timeoutMs: "100" }]) {
    await assert.rejects(spy("https://example.com/", bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(calls.length, 2, "nothing fetched with a raised or invalid cap");
  assert.ok(Object.isFrozen(USER_URL_LIMITS));
});

test("SM-15-L1: a user URL never uses allowHosts, a body or a method other than GET/HEAD", async () => {
  // A declared internal service is reachable through safeFetch's allowHosts; a user URL can never ask for it.
  await assert.rejects(fetchUserUrl("http://internal.test/", { allowHosts: ["internal.test"], lookup }), TypeError);
  await assert.rejects(fetchUserUrl("http://example.com/", { body: "x" }), TypeError);
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "CONNECT", "TRACE"]) await assert.rejects(fetchUserUrl("http://example.com/", { method }), TypeError);
  for (const input of [null, undefined, 42, { toString: () => "http://example.com/" }, new URL("http://example.com/")]) {
    await assert.rejects(fetchUserUrl(input), (e) => e instanceof SafeFetchError && e.code === "url");
  }
  await refused(`http://example.com/${"a".repeat(USER_URL_LIMITS.maxUrlLength)}`, "url");
  await refused(`http://example.com/${"\u00e9".repeat(1000)}`, "url");   // 1019 characters typed, over 6000 once encoded
  assert.equal(parseUserUrl("  https://Example.COM/x  ").href, "https://example.com/x");
  assert.throws(() => makeUserUrlFetcher({ transport: "safeFetch" }), TypeError);
});

test("SM-15-L1: what the user is told never says whether an internal name exists", async () => {
  const msg = async (url) => { try { await fetchUserUrl(url, { lookup: async (h) => { if (h === "nope.test") { const e = new Error("x"); e.code = "ENOTFOUND"; throw e; } return lookup(h); } }); }
    catch (e) { return publicMessage(e); } return null; };
  const internal = await msg("http://internal.test/"), missing = await msg("http://nope.test/");
  assert.equal(internal, missing, "an internal name and a missing name read the same");
  for (const m of [internal, await msg("file:///etc/passwd"), await msg("http://u:p@example.com/")]) {
    assert.ok(m && !/internal\.test|nope\.test|ENOTFOUND|10\.1\.2\.3|passwd/.test(m), m);
  }
  assert.equal(publicMessage(new Error("boom")), "The page could not be fetched.");
  assert.equal(publicMessage(new SafeFetchError("constructor", "x")), "The page could not be fetched.");
});
