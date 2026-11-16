// F2-2: the 10 internal-URL cases plus encoded forms; time and size caps. A local stub stands in for a
// public server through allowHosts (the only bypass), so the tests never leave the machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { safeFetch, isBlockedAddress, redirectHeaders } from "../src/safe-fetch.mjs";

// Egress guard (pre-review, low): every socket these tests open must go to the loopback stub. safeFetch pins the
// address through the request's lookup option, so read it there; any other target throws before a socket exists,
// and safeFetch reports it as code "request". A regression then fails the test with no real egress.
const realRequest = { http: http.request, https: https.request };
const pinned = (o) => { let a; o.lookup?.(o.hostname, {}, (_e, addr) => { a = addr; }); return a; };
for (const [name, mod] of [["http", http], ["https", https]]) {
  mod.request = function guarded(o, ...rest) {
    if (pinned(o) !== "127.0.0.1") throw new Error(`test egress guard: refused a socket to ${o.hostname}`);
    return realRequest[name].call(this, o, ...rest);
  };
}

let srv, port;
before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === "/ok") { res.end("hello"); return; }
    if (req.url === "/big") { res.end(Buffer.alloc(2048, 97)); return; }
    if (req.url === "/slow") { setTimeout(() => res.end("late"), 500); return; }
    if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
    if (req.url === "/to-internal-name") { res.writeHead(302, { location: "http://evil.test/" }); res.end(); return; }
    if (req.url === "/to-declared") { res.writeHead(302, { location: `http://stub.test:${port}/ok` }); res.end(); return; }
    if (req.url === "/to-other-origin") { res.writeHead(307, { location: `http://other.test:${port}/echo` }); res.end(); return; }
    if (req.url.startsWith("/to-port?p=")) { res.writeHead(302, { location: `http://far.test:${Number(req.url.slice(11))}/ok` }); res.end(); return; }
    if (req.url === "/to-same-origin") { res.writeHead(308, { location: "/echo" }); res.end(); return; }
    if (req.url === "/see-other") { res.writeHead(303, { location: "/echo-headers" }); res.end(); return; }
    if (req.url === "/echo-headers") { res.end(JSON.stringify({ method: req.method, cl: req.headers["content-length"] || null, ct: req.headers["content-type"] || null, te: req.headers["transfer-encoding"] || null })); return; }
    if (req.url === "/echo") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => res.end(JSON.stringify({ method: req.method, body: b, auth: req.headers.authorization || null, cookie: req.headers.cookie || null, accept: req.headers.accept || null }))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(() => { http.request = realRequest.http; https.request = realRequest.https; srv.close(); });

const stub = { allowHosts: ["stub.test"], lookup: async (h) => (h === "stub.test" ? [{ address: "127.0.0.1", family: 4 }]
  : h === "evil.test" ? [{ address: "10.1.2.3", family: 4 }]
  : h === "rebind.test" ? [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.5", family: 4 }]
  : h === "v6ula.test" ? [{ address: "fd00::1", family: 6 }]
  : [{ address: "93.184.216.34", family: 4 }]) };
const refused = async (url, code = "blocked-address") =>
  assert.rejects(safeFetch(url, stub), (e) => { assert.equal(e.code, code, `${url}: ${e.code} ${e.message}`); return true; });

test("F2-2 case 1-2: loopback and RFC 1918", async () => {
  await refused("http://127.0.0.1/"); await refused("http://10.0.0.8/"); await refused("http://172.16.4.4/"); await refused("http://192.168.0.1/");
});
test("F2-2 case 3: link-local and cloud metadata", async () => { await refused("http://169.254.169.254/latest/meta-data/"); });
test("F2-2 case 4: CGNAT / tailnet 100.64.0.0/10", async () => { await refused("http://100.101.102.103/"); });
test("F2-2 case 5: Docker default range", async () => { await refused("http://172.17.0.1:8000/"); });
test("F2-2 case 6-7: IPv6 loopback and ULA (literal and resolved)", async () => {
  await refused("http://[::1]/"); await refused("http://[fd12:3456::1]/"); await refused("http://v6ula.test/");
});
test("F2-2 case 8: non-HTTP schemes", async () => {
  await refused("file:///etc/passwd", "scheme"); await refused("gopher://example.com/", "scheme"); await refused("ftp://example.com/", "scheme");
});
test("F2-2 case 9: a name that resolves to an internal address (any of its addresses)", async () => {
  await refused("http://evil.test/"); await refused("http://rebind.test/");
});
test("F2-2 case 10: a redirect to an internal address", async () => {
  await refused(`http://stub.test:${port}/to-metadata`);
  await refused(`http://stub.test:${port}/to-internal-name`);
});
test("encoded and mapped forms are refused", async () => {
  await refused("http://2130706433/");        // 127.0.0.1 as a decimal
  await refused("http://0x7f.0.0.1/");         // hex octet
  await refused("http://0177.0.0.1/");         // octal octet
  await refused("http://[::ffff:127.0.0.1]/"); // IPv4-mapped IPv6
  await refused("http://[::ffff:a9fe:a9fe]/"); // mapped metadata, hex form
  await refused("http://[64:ff9b::a00:1]/");   // NAT64 of 10.0.0.1
  await refused("http://0.0.0.0/");
  assert.equal(isBlockedAddress("not-an-ip"), true);
  assert.equal(isBlockedAddress("93.184.216.34"), false);
  assert.equal(isBlockedAddress("2606:2800:220:1::1"), false);
});
test("credentials in the URL are refused", async () => { await refused("http://u:p@stub.test/", "credentials"); });
test("an allowed host is fetched; size and time caps hold", async () => {
  const r = await safeFetch(`http://stub.test:${port}/ok`, stub);
  assert.equal(r.status, 200); assert.equal(r.text(), "hello");
  await assert.rejects(safeFetch(`http://stub.test:${port}/big`, { ...stub, maxBytes: 1024 }), (e) => e.code === "too-large");
  await assert.rejects(safeFetch(`http://stub.test:${port}/slow`, { ...stub, timeoutMs: 100 }), (e) => e.code === "timeout");
});

test("allowHosts applies only to the URL passed in, never to a redirect target", async () => {
  // public.test is a public name whose stub happens to listen locally; it redirects into the declared service.
  const lookups = [];
  const opts = { allowHosts: ["stub.test"], lookup: async (h) => { lookups.push(h); return [{ address: h === "stub.test" ? "127.0.0.1" : "93.184.216.34", family: 4 }]; } };
  const r = await safeFetch(`http://stub.test:${port}/to-declared`, opts);   // declared -> same origin: allowed
  assert.equal(r.status, 200, "the declared host itself is reachable");
  await assert.rejects(safeFetch(`http://stub.test:${port}/to-declared`, { ...opts, maxRedirects: 5, allowHosts: [] }), (e) => e.code === "blocked-address");
});
test("credential headers are dropped when a redirect changes origin; 307/308 keep the method and body", async () => {
  const opts = { allowHosts: ["stub.test", "other.test"], lookup: async () => [{ address: "127.0.0.1", family: 4 }] };
  const hdr = { authorization: "Bearer app-token", cookie: "s=1", "x-service-token": "t", accept: "application/json" };
  // other.test is a different origin from the first hop, so its allowance does not apply: refused.
  await assert.rejects(safeFetch(`http://stub.test:${port}/to-other-origin`, { ...opts, headers: hdr }), (e) => e.code === "blocked-address");
  const same = JSON.parse((await safeFetch(`http://stub.test:${port}/to-same-origin`, { ...opts, method: "POST", body: "x=1", headers: hdr })).text());
  assert.deepEqual(same, { method: "POST", body: "x=1", auth: "Bearer app-token", cookie: "s=1", accept: "application/json" });
});
test("a 303 after a POST becomes a GET without the body or its headers (Codex PR32-r1)", async () => {
  const r = await safeFetch(`http://stub.test:${port}/see-other`, { ...stub, method: "POST", body: "abc", timeoutMs: 2000,
    headers: { "Content-Length": "3", "content-type": "text/plain", accept: "application/json" } });
  assert.deepEqual(JSON.parse(r.text()), { method: "GET", cl: null, ct: null, te: null });
});
test("credentials are dropped when the origin changes, kept within the origin", () => {
  const h = { authorization: "Bearer x", cookie: "c", "x-api-key": "k", "x-service-token": "t", "proxy-authorization": "p", api_key: "k", "x-auth": "a", "x-functions-key": "f", "x-session": "s", accept: "a", "user-agent": "u" };
  assert.deepEqual(redirectHeaders(h, "http://a.test", "http://b.test"), { accept: "a", "user-agent": "u" });
  assert.deepEqual(redirectHeaders(h, "http://a.test", "https://a.test"), { accept: "a", "user-agent": "u" }, "scheme change is a new origin");
  assert.equal(redirectHeaders(h, "http://a.test", "http://a.test"), h);
});
test("one lookup per hop, and the socket goes to the checked address", async () => {
  const seen = [];
  const r = await safeFetch(`http://stub.test:${port}/to-same-origin`, { allowHosts: ["stub.test"], lookup: async (x) => { seen.push(x); return [{ address: "127.0.0.1", family: 4 }]; } });
  assert.equal(r.status, 200); assert.deepEqual(seen, ["stub.test", "stub.test"]);
});
test("allowHosts must be exact hostnames; resolution failures and bad URLs are SafeFetchErrors", async () => {
  for (const bad of ["127.0.0.1", "localhost", "*.internal", "[::1]", ""]) {
    await assert.rejects(safeFetch("http://example.com/", { allowHosts: [bad] }), (e) => e.code === "allow-hosts", bad);
  }
  await assert.rejects(safeFetch("http://nx.test/", { lookup: async () => { const e = new Error("x"); e.code = "ENOTFOUND"; throw e; } }), (e) => e.code === "dns");
  await assert.rejects(safeFetch("not a url"), (e) => e.code === "url");
});
test("IPv6 forms that embed an internal IPv4 address are refused", () => {
  for (const a of ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "2002:7f00:1::1", "2002:a9fe:a9fe::", "fec0::1", "100::1", "::ffff:10.0.0.1"]) assert.equal(isBlockedAddress(a), true, a);
  assert.equal(isBlockedAddress("2002:5db8:d822::1"), false, "6to4 of a public address");
});

test("Teredo 2001::/32 is refused; other 2001: space is not (DEVOS-64 floor line)", () => {
  for (const a of ["2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:0000:ffff::"]) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ["2001:4860:4860::8888", "2001:1::1"]) assert.equal(isBlockedAddress(a), false, a);
});
test("allowPorts limits the port of every hop, before any connection; bad lists are refused (DEVOS-64 floor line)", async () => {
  let lookups = 0;
  const counted = { ...stub, allowHosts: ["public.test"], lookup: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; } };
  // The URL passed in: an explicit port off the list, and the scheme's default port off the list. The name resolves
  // to the stub, so a connection would reach it; the refusal comes first.
  await assert.rejects(safeFetch(`http://public.test:${port}/ok`, { ...counted, allowPorts: [80, 443] }), (e) => e.code === "port" && e.message.includes(String(port)));
  await assert.rejects(safeFetch("https://example.com/", { ...stub, allowPorts: [80] }), (e) => e.code === "port" && /443/.test(e.message));
  assert.equal(lookups, 1, "one lookup, then refused");
  // An internal target on an unlisted port is still reported as blocked-address (the address check comes first).
  await assert.rejects(safeFetch("http://10.0.0.1:2375/", { ...stub, allowPorts: [80, 443] }), (e) => e.code === "blocked-address");
  // A listed port is fetched; a redirect to another port is refused on that hop (far.test resolves to a public
  // address in the stub resolver, so only the port rule stops it, before any connection).
  assert.equal((await safeFetch(`http://stub.test:${port}/ok`, { ...stub, allowPorts: [port] })).text(), "hello");
  const other = port === 65535 ? 65534 : port + 1;
  await assert.rejects(safeFetch(`http://stub.test:${port}/to-port?p=${other}`, { ...stub, allowPorts: [port] }), (e) => e.code === "port" && e.message.includes(String(other)));
  // Without allowPorts any port is allowed (declared services keep their own ports).
  assert.equal((await safeFetch(`http://stub.test:${port}/ok`, stub)).status, 200);
  for (const bad of [[], [0], [65536], [80.5], ["80"], "80", null]) {
    await assert.rejects(safeFetch("http://example.com/", { allowPorts: bad }), (e) => e.code === "allow-ports", JSON.stringify(bad));
  }
});

test("an unsupported body is a SafeFetchError with a code, and nothing is left running (Codex PR32-r8)", async () => {
  const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout" || x === "TCPSocketWrap").length;
  await assert.rejects(safeFetch(`http://stub.test:${port}/echo`, { ...stub, method: "POST", body: { not: "a buffer" }, timeoutMs: 2000 }),
    (e) => e.name === "SafeFetchError" && e.code === "request");
  await new Promise((r) => setTimeout(r, 50));   // let a destroyed socket finish closing
  const after = process.getActiveResourcesInfo().filter((x) => x === "Timeout" || x === "TCPSocketWrap").length;
  assert.ok(after <= before, `resources left: ${before} -> ${after}`);
});
