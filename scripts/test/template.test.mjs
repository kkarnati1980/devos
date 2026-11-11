// S3-a (DEVOS-92): golden-path core, apply tool and static floor checks. Contract: docs/modules/S3.md AT1–AT6.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../template/apply.mjs";
import { floorCheck } from "../template/floor-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-template-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = (name, select = []) => { const out = path.join(tmp, name); const r = apply({ out, select, sha: "a".repeat(40) }); assert.equal(r.code, 0, r.error); return out; };
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test("AT1: no selection gives the core only, with a manifest, and the core passes the floor checks", () => {
  const out = fresh("core");
  const m = JSON.parse(fs.readFileSync(path.join(out, ".devos/template.json"), "utf8"));
  assert.deepEqual([m.selected, m.applied, m.pending], [[], [], []]);
  assert.equal(m.devosSha, "a".repeat(40));
  for (const f of ["src/safe-fetch.mjs", "src/config.mjs", "src/server.mjs", "compose.yaml", "Dockerfile", "package.json"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, "addons")), "no add-on content");
  assert.deepEqual(floorCheck(out), []);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/floor-check.mjs"), out], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("AT2/AT4/AT5: the generated core's own tests pass (F2-2 corpus, caps, /health, /ready, logs, F1 client allow-list)", () => {
  const out = fresh("core-tests");
  const r = spawnSync(process.execPath, ["--test", "test/safe-fetch.test.mjs", "test/server.test.mjs"], { cwd: out, encoding: "utf8", timeout: 60_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-2000));
  assert.match(r.stdout, /# pass 14/);
  assert.match(r.stdout, /# fail 0/);
});

test("AT3: floor-check names F2-1, F1-4 and F3-2 violations", () => {
  const out = fresh("bad");
  write(out, "src/feed.mjs", "export const get = (u) => fetch(u);\n");
  write(out, "src/sock.mjs", 'import { request } from "node:https";\nexport default request;\n');
  write(out, "src/client.mjs", 'import axios from "axios";\nexport default axios;\n');
  write(out, "test/helper.test.mjs", "await fetch('http://localhost');\n");   // tests may use fetch
  write(out, "public/app.js", "const k = process.env.API_KEY;\n");
  write(out, "src/cfg.mjs", 'export const CLIENT_CONFIG_KEYS = ["PUBLIC_NAME", "STRIPE_SECRET_KEY"];\n');
  fs.writeFileSync(path.join(out, "compose.yaml"), "services:\n  app:\n    build: .\n    cpus: '0.5'\n  worker:\n    build: .\n    network_mode: host\n    deploy: { resources: { limits: { cpus: '0.2', memory: 128m, pids: 64 } } }\n");
  const f = floorCheck(out);
  const has = (re) => assert.ok(f.some((l) => re.test(l)), `${re} in\n${f.join("\n")}`);
  has(/^FAIL F2-1 src\/feed\.mjs: .*fetch\(/);
  has(/^FAIL F2-1 src\/sock\.mjs: .*node:http/);
  has(/^FAIL F2-1 src\/client\.mjs: .*package/);
  has(/^FAIL F1-4 public\/app\.js: client code reads process\.env/);
  has(/^FAIL F1-4 src\/cfg\.mjs: secret-shaped client config key "STRIPE_SECRET_KEY"/);
  has(/^FAIL F3-2 compose\.yaml: service app has no memory limit/);
  has(/^FAIL F3-2 compose\.yaml: service app has no pid limit/);
  has(/^FAIL F3-2 compose\.yaml: service worker uses the host network/);
  assert.ok(!f.some((l) => /helper\.test/.test(l)), "test files may use fetch");
  assert.ok(!f.some((l) => /service worker has no/.test(l)), "deploy.resources.limits count as limits");
  assert.ok(!f.some((l) => /^FAIL \S+ src\/(server|safe-fetch|config|log)\.mjs:/.test(l)), "the core itself is clean");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/floor-check.mjs"), out], { encoding: "utf8" });
  assert.equal(cli.status, 1);
});

test("AT6: apply refuses unknown, floor or opt-in IDs and a non-empty output, writing nothing; a module with no add-on is pending", () => {
  for (const sel of [["SM-99"], ["F2"], ["SM-C3"], ["SM-01", "bogus"]]) {
    const out = path.join(tmp, `refused-${sel.join("-")}`);
    const r = apply({ out, select: sel });
    assert.equal(r.code, 2); assert.match(r.error, /not a selectable module/);
    assert.ok(!fs.existsSync(out), "nothing written");
  }
  const busy = path.join(tmp, "busy"); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, "keep.txt"), "mine");
  const r = apply({ out: busy, select: [] });
  assert.equal(r.code, 2); assert.match(r.error, /not empty/);
  assert.deepEqual(fs.readdirSync(busy), ["keep.txt"]);
  assert.ok(!fs.readdirSync(tmp).some((n) => n.includes(".partial-")), "no staging left behind");
  const out = fresh("pending", ["SM-09", "SM-15"]);
  const m = JSON.parse(fs.readFileSync(path.join(out, ".devos/template.json"), "utf8"));
  assert.deepEqual(m.selected, ["SM-09", "SM-15"]); assert.deepEqual(m.pending, ["SM-09", "SM-15"]); assert.deepEqual(m.applied, []);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/apply.mjs"), "--out", path.join(tmp, "cli"), "--select", "SM-99"], { encoding: "utf8" });
  assert.equal(cli.status, 2); assert.match(cli.stderr, /refused/); assert.ok(!fs.existsSync(path.join(tmp, "cli")));
});

test("the template ships no add-on yet, and no secret or env file", () => {
  const addons = path.join(ROOT, "templates/golden-path/addons");
  assert.deepEqual(fs.readdirSync(addons).filter((n) => n !== ".gitkeep"), []);
  const core = execFileSync("git", ["ls-files", "templates/golden-path"], { cwd: ROOT, encoding: "utf8" });
  assert.ok(!/\.env(\.|$)/m.test(core));
});
