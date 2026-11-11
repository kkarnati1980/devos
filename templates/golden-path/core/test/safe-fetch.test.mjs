// F2-2: the 10 internal-URL cases plus encoded forms; time and size caps. A local stub stands in for a
// public server through allowHosts (the only bypass), so the tests never leave the machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { safeFetch, isBlockedAddress } from "../src/safe-fetch.mjs";

let srv, port;
before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === "/ok") { res.end("hello"); return; }
    if (req.url === "/big") { res.end(Buffer.alloc(2048, 97)); return; }
    if (req.url === "/slow") { setTimeout(() => res.end("late"), 500); return; }
    if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
    if (req.url === "/to-internal-name") { res.writeHead(302, { location: "http://evil.test/" }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(() => srv.close());

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
