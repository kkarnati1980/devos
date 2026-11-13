// SM-04 add-on tests (docs/modules/S3.md, "S3-b4 SM-04 build notes").
// SM-04-L1: every outbound call has an explicit timeout; a stubbed hanging dependency fails within it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { outbound, withDeadline, findUntimedCalls, OutboundTimeout, MAX_TIMEOUT_MS } from "../src/outbound.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let srv, port;
const sockets = new Set();
before(async () => {
  // A stub dependency: /hang accepts the request and never answers; /ok answers at once.
  srv = http.createServer((req, res) => { if (req.url === "/ok") res.end("fine"); });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(() => { for (const s of sockets) s.destroy(); srv.close(); });
const stub = { allowHosts: ["dep.test"], lookup: async () => [{ address: "127.0.0.1", family: 4 }] };

test("SM-04-L1: a hanging HTTP dependency fails within the client's timeout", async () => {
  const dep = outbound({ name: "payments", baseUrl: `http://dep.test:${port}`, timeoutMs: 300, ...stub });
  assert.equal((await dep.call("/ok")).text(), "fine");
  const started = Date.now();
  await assert.rejects(dep.call("/hang"), (e) => e instanceof OutboundTimeout && e.code === "timeout" && e.dependency === "payments" && e.timeoutMs === 300);
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 1500, `failed after ${took} ms`);
  // A call may lower the timeout, never raise it past the client's or drop it.
  const t2 = Date.now();
  await assert.rejects(dep.call("/hang", { timeoutMs: 100 }), OutboundTimeout);
  assert.ok(Date.now() - t2 < 900);
  await assert.rejects(dep.call("/hang", { timeoutMs: 301 }), /may not exceed/);
  await assert.rejects(dep.call("/hang", { timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(dep.call("/hang", { timeoutMs: null }), /timeoutMs/);
  // The path stays on the dependency's origin.
  await assert.rejects(dep.call("http://other.test/x"), /must stay on/);
  await assert.rejects(dep.call("//other.test/x"), /must stay on/);
});

test("SM-04-L1: a hanging non-HTTP call fails within withDeadline's timeout and its signal is aborted", async () => {
  let signal;
  const started = Date.now();
  await assert.rejects(withDeadline("db", 200, (s) => { signal = s; return new Promise(() => {}); }), (e) => e instanceof OutboundTimeout && e.dependency === "db");
  const took = Date.now() - started;
  assert.ok(took >= 150 && took < 1200, `failed after ${took} ms`);
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof OutboundTimeout);
  assert.equal(await withDeadline("db", 1000, async () => 42), 42);
  await assert.rejects(withDeadline("db", 1000, async () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(withDeadline("db", 1000, () => { throw new Error("sync boom"); }), /sync boom/);
  // A late failure after the deadline is not an unhandled rejection.
  await assert.rejects(withDeadline("db", 50, () => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 120))), OutboundTimeout);
  await new Promise((r) => setTimeout(r, 150));
});

test("SM-04-L1: no outbound call without an explicit timeout (set-up refusals)", () => {
  for (const ms of [undefined, null, 0, -1, 1.5, "1000", MAX_TIMEOUT_MS + 1, Infinity]) {
    assert.throws(() => outbound({ name: "dep", baseUrl: "https://dep.example", timeoutMs: ms }), /timeoutMs/, String(ms));
    assert.throws(() => withDeadline("dep", ms, () => 1), /timeoutMs/, String(ms));
  }
  for (const name of [undefined, "", "Has Space", "UPPER", "x".repeat(41)]) assert.throws(() => outbound({ name, baseUrl: "https://dep.example", timeoutMs: 1000 }), /name/);
  for (const baseUrl of [undefined, "dep.example", "ftp://dep.example", "file:///etc/passwd"]) assert.throws(() => outbound({ name: "dep", baseUrl, timeoutMs: 1000 }), /baseUrl/);
  assert.throws(() => withDeadline("dep", 1000, "not a function"), /work/);
  assert.equal(outbound({ name: "dep", baseUrl: "https://dep.example", timeoutMs: 1000 }).timeoutMs, 1000);
});

test("SM-04-L1: the untimed-call check finds every call without timeoutMs and passes this app", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm04-"));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const F = ["safe", "Fetch"].join(""); // fixtures are assembled so this test file holds no call itself
  write("src/a.mjs", `const a = 1;\nawait ${F}(url);\n`);
  write("src/b.mjs", `const a = 1;\nawait ${F}(url, { method: "POST", headers: h(x) });\n`);
  write("src/c.mjs", `const a = 1;\nawait ${F} (\n  url,\n  opts,\n);\n`);
  write("src/ok.mjs", `await ${F}(url, {\n  method: "GET",\n  timeoutMs: 2000,\n});\nawait ${F}(u, { timeoutMs: cfg.t });\n`);
  write("src/safe-fetch.mjs", `export async function ${F}(input, opts = {}) {}\n`);
  write("node_modules/x/i.js", `${F}(url);\n`);
  const hits = findUntimedCalls(dir);
  assert.deepEqual(hits, [{ file: "src/a.mjs", line: 2 }, { file: "src/b.mjs", line: 2 }, { file: "src/c.mjs", line: 2 }]);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(findUntimedCalls(APP_ROOT), []);
});
