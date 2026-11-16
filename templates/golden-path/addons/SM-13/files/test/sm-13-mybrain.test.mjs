// SM-13-L1: responses carry frame-ancestors 'none' and no Access-Control-Allow-Origin; no MyBrain credential in
// the app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { applyLinkOut, findMyBrainSecrets, headerFindings, scanApp, withFrameAncestorsNone } from "../src/mybrain-link.mjs";
import { main } from "../scripts/mybrain-scan.mjs";

const config = { server: { port: 0, host: "127.0.0.1", sha: "test" }, clientConfig: () => ({}) };
// Routes that try every way to leak a CORS header or allow framing.
const routes = {
  "GET /": (_q, res) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("access-control-allow-credentials", "true"); res.end("home"); },
  "GET /obj": (_q, res) => { res.writeHead(200, { "Access-Control-Allow-Origin": "https://evil.example", "Content-Security-Policy": "default-src 'self'; frame-ancestors *" }); res.end("x"); },
  "GET /list": (_q, res) => { res.writeHead(200, "OK", ["access-control-allow-origin", "*", "x-frame-options", "ALLOWALL", "content-type", "text/plain"]); res.end("y"); },
  "GET /csp": (_q, res) => { res.setHeader("content-security-policy", ["script-src 'self'", "frame-ancestors https://mybrain.example"]); res.end("z"); },
  "GET /comma": (_q, res) => { res.setHeader("content-security-policy", "default-src 'self', frame-ancestors https://evil.example"); res.end("c"); },
  "OPTIONS /": (_q, res) => { res.writeHead(204, { "access-control-allow-methods": "POST" }); res.end(); },
};
const paths = ["/", "/obj", "/list", "/csp", "/comma", "/health", "/ready", "/missing"];
const tmp = { dir: "" };
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const silent = { write() {} };
let open, plain, openUrl, plainUrl;
before(async () => {
  tmp.dir = mkdtempSync(join(tmpdir(), "sm13-"));
  open = applyLinkOut(createApp({ config, routes, out: silent })); openUrl = await listen(open);
  plain = createApp({ config, routes, out: silent }); plainUrl = await listen(plain);
});
after(() => { open.close(); plain.close(); rmSync(tmp.dir, { recursive: true, force: true }); });

test("SM-13-L1 every response carries frame-ancestors 'none' and no Access-Control-Allow-* header", async () => {
  const report = await scanApp({ baseUrl: openUrl, paths });
  assert.equal(report.ok, true, report.findings.join("\n"));
  assert.equal(report.checked.length, paths.length * 2, "GET and an OPTIONS preflight per path");
  assert.equal(report.check, "SM-13-L1");
  // A route's own CSP is kept; only its frame-ancestors becomes 'none'.
  const r = await scanApp({ baseUrl: openUrl, paths: ["/obj"], fetcher: async (url, opts) => {
    const { safeFetch } = await import("../src/safe-fetch.mjs");
    const res = await safeFetch(url, opts);
    if (opts.method === "GET") assert.equal(res.headers["content-security-policy"], "default-src 'self'; frame-ancestors *, frame-ancestors 'none'", "the route's policy is kept and a 'none' policy is added");
    return res;
  } });
  assert.equal(r.ok, true);
});

test("SM-13-L1 the scan catches an app without the profile (negative control)", async () => {
  const report = await scanApp({ baseUrl: plainUrl, paths });
  assert.equal(report.ok, false);
  assert.ok(report.findings.includes("GET /health: frame-ancestors-not-none"));
  assert.ok(report.findings.includes("GET /: cors-header:access-control-allow-origin"));
  assert.ok(report.findings.includes("OPTIONS /: cors-header:access-control-allow-methods"));
  const down = await scanApp({ baseUrl: "http://127.0.0.1:1", paths: ["/health"] });
  assert.equal(down.ok, false, "an unreachable app is a finding, never a pass");
  await assert.rejects(scanApp({ baseUrl: "file:///etc", paths }), TypeError);
  await assert.rejects(scanApp({ baseUrl: openUrl, paths: ["//evil.example/"] }), TypeError);
});

test("SM-13-L1 header rules", () => {
  assert.deepEqual(withFrameAncestorsNone(undefined), ["frame-ancestors 'none'"]);
  assert.deepEqual(withFrameAncestorsNone(["a", "frame-ancestors 'none'"]), ["a", "frame-ancestors 'none'"]);
  assert.deepEqual(headerFindings({ "content-security-policy": "default-src 'self', frame-ancestors https://evil.example; frame-ancestors 'none'" }), ["frame-ancestors-not-none"], "a 'none' after another frame-ancestors in the same policy is ignored by browsers");
  assert.deepEqual(headerFindings({ "content-security-policy": "default-src 'self', frame-ancestors https://evil.example, frame-ancestors 'none'" }), []);
  assert.deepEqual(headerFindings({ "Content-Security-Policy": "frame-ancestors 'none'" }), []);
  assert.deepEqual(headerFindings({ "content-security-policy": "frame-ancestors 'none' https://x" }), ["frame-ancestors-not-none"]);
  assert.deepEqual(headerFindings({ "content-security-policy": "default-src 'self'", "Access-Control-Allow-Origin": "*" }), ["frame-ancestors-not-none", "cors-header:access-control-allow-origin"]);
});

test("SM-13-L1 no MyBrain credential in the app; the CLI writes the scan_report and exits by it", async () => {
  const app = join(tmp.dir, "app"); mkdirSync(join(app, "src"), { recursive: true }); mkdirSync(join(app, "test"));
  writeFileSync(join(app, "src", "ok.mjs"), "// opened from MyBrain as a link; no token here\n");
  writeFileSync(join(app, "test", "fake.mjs"), "const MYBRAIN_API_TOKEN = 'fake';\n");
  assert.deepEqual(findMyBrainSecrets(app), []);
  symlinkSync(app, join(app, "src", "loop"));   // a link loop is not followed
  assert.deepEqual(findMyBrainSecrets(app), []);
  // The applied app itself (this test's own folder's parent) names no MyBrain credential.
  assert.deepEqual(findMyBrainSecrets(dirname(dirname(fileURLToPath(import.meta.url)))), []);
  writeFileSync(join(app, ".env.example"), "MYBRAIN_API_TOKEN=\n");
  writeFileSync(join(app, "src", "client.mjs"), "const k = process.env.MY_BRAIN_SESSION_COOKIE;\n");
  assert.deepEqual(findMyBrainSecrets(app).map((f) => f.split(":")[0]).sort(), [".env.example", "src/client.mjs"]);

  const out = join(tmp.dir, "report.json"); let text = "";
  const code = await main(["--url", openUrl, "--paths", "/,/health", "--out", out], { root: join(tmp.dir, "none-app"), print: (s) => (text += s) }).catch((e) => e);
  assert.ok(code instanceof Error, "a missing root is an error, not a pass");
  mkdirSync(join(tmp.dir, "clean"));
  assert.equal(await main(["--url", openUrl, "--paths", "/,/health", "--out", out], { root: join(tmp.dir, "clean"), print: (s) => (text += s) }), 0);
  const rep = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(rep.ok, true); assert.equal(rep.checked.length, 4); assert.match(text, /SM-13-L1: pass/);
  assert.equal(await main(["--url", openUrl, "--paths", "/"], { root: app, print: () => {} }), 1, "a credential fails the scan");
  const inRoot = join(tmp.dir, "clean", "scan-report.json");
  writeFileSync(inRoot, JSON.stringify({ findings: ["src/x.mjs: names a MyBrain credential (MYBRAIN_API_TOKEN)"] }));
  assert.equal(await main(["--url", openUrl, "--paths", "/", "--out", inRoot], { root: join(tmp.dir, "clean"), print: () => {} }), 0, "the scan's own old report is skipped");
  assert.equal(await main(["--url", plainUrl, "--paths", "/"], { root: join(tmp.dir, "clean"), print: () => {} }), 1);
  assert.equal(await main([], { print: () => {} }), 2);
});
