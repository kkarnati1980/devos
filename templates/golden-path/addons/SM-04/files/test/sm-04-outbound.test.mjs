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

test("SM-04-L1: signal-aware work that settles on abort still loses to the OutboundTimeout", async () => {
  // The deadline must settle before the abort fires, so work that resolves on abort cannot win the race.
  await assert.rejects(
    withDeadline("queue", 60, (s) => new Promise((resolve) => s.addEventListener("abort", () => resolve("cancelled")))),
    (e) => e instanceof OutboundTimeout && e.dependency === "queue",
  );
  // Work that rejects with its own cancellation error on abort also loses to the OutboundTimeout.
  await assert.rejects(
    withDeadline("sdk", 60, (s) => new Promise((_, rej) => s.addEventListener("abort", () => rej(new Error("SDK aborted"))))),
    OutboundTimeout,
  );
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
  const M = ["safe", "fetch"].join("-");
  const bad = {
    "src/a.mjs": `await ${F}(url);`,
    "src/b.mjs": `await ${F}(url, { method: "POST", headers: h(x) });`,
    "src/c.mjs": `await ${F} (\n  url,\n  opts,\n);`,
    "src/d.mjs": `import { ${F} as sf } from "./${M}.mjs";`,
    "src/e.mjs": `const f = ${F};`,
    "src/f.mjs": `await ${F}?.(url);`,
    "src/g.mjs": `await ${F}.call(null, url);`,
    "src/h.mjs": `urls.map(${F});`,
    "src/i.mjs": `import * as F from "./${M}.mjs";`,
    "src/j.mjs": `const m = await import("./${M}.mjs");`,
    "src/k.mjs": `await ${F}(url, { headers: { x: "(" } }); other({ timeoutMs: 5 });`,
    "src/l.mjs": `await ${F}(url /* timeoutMs: 5000 */);`,
    "src/m.mjs": `await ${F}(url, { headers: { "x-note": "timeoutMs: 5" } });`,
    "src/n.mjs": `await ${F}(build({ timeoutMs: 5 }), opts);`,
    "src/o.mjs": `await ${F}(url, { timeoutMs: undefined });`,
    "src/p.mjs": `await ${F}(url, { timeoutMs: 2e9 });`,
    "src/q.mjs": `await ${F}(url, { timeoutMs: 0 });`,
    "src/r.mjs": `await ${F}(...args);`,
    "src/s.mjs": `await ${F}(url, { ...opts });`,
    "src/t.mjs": `await ${F}(url, { timeoutMs: 5000, ...opts });`,
    "src/u.mjs": `await ${F}(url, { timeoutMs: 5000, timeoutMs: undefined });`,
    "src/v.mjs": `await ${F}(url, { timeoutMs: 0x7fffffff });`,
    "src/w.mjs": `await ${F}(url, { timeoutMs: -1 });`,
    "src/x.mjs": "if (/^https?:\\/\\//.test(u)) await " + F + "(u);",
    "src/y.mjs": "/'/.test(s) && await " + F + "(u);",
    "src/z1.mjs": "const re = /^\\/*$/;\nawait " + F + "(u);",
    "src/z2.mjs": "const re = /`/;\nawait " + F + "(u);",
  };
  for (const [rel, text] of Object.entries(bad)) write(rel, `const a = 1;\n${text}\n`);
  write("src/ok.mjs", [
    `import { ${F} } from "./${M}.mjs";`,
    `await ${F}(url, {\n  method: "GET",\n  timeoutMs: 2000,\n});`,
    `await ${F}(u, { timeoutMs: cfg.t });`,
    `const timeoutMs = 2000; await ${F}(url, { timeoutMs });`,
    `// never call ${F}(url) without a timeout`,
    `log("${F}(" + u + ") failed");`,
    `await ${F}(url, { headers: { x: ")" }, timeoutMs: 1000 });`,
    `await ${F}(\`https://api.example/\${id}\`, { ...base, timeoutMs: 120_000 });`,
    `const note = \`call ${F}(\${u}) with care\`;`,
    `await ${F}(url, { "timeoutMs": 1000 });`,
    `await ${F}(url, { ...defaults, timeoutMs: 0x3e8 } as const);`,
    `const half = total / 2 / 3; await ${F}(url, { timeoutMs: 1000 });`,
  ].join("\n") + "\n");
  write("src/lib/imp.mjs", `import { ${F}, SafeFetchError } from "../${M}.mjs"; // the F2 fetch\nawait ${F}(u, { timeoutMs: 500 });\n`);
  write(`src/${M}.mjs`, `export async function ${F}(input, opts = {}) {}\n`);
  write("node_modules/x/i.js", `${F}(url);\n`);
  const hits = findUntimedCalls(dir);
  assert.deepEqual([...new Set(hits.map((h) => h.file))].sort(), Object.keys(bad).sort(), JSON.stringify(hits, null, 1));
  for (const h of hits) assert.equal(h.line, h.file.startsWith("src/z") ? 3 : 2, JSON.stringify(h));
  assert.ok(hits.every((h) => typeof h.reason === "string" && h.reason), "each hit says why");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(findUntimedCalls(APP_ROOT), []);
});
