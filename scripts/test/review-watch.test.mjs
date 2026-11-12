// DEVOS-105 review watcher heartbeat (docs/modules/review-watch.md v1.2.0) against a mock GitHub API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WATCH = path.join(ROOT, "scripts/review/review-watch.sh");
const TOKEN = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";
const MAIN = "c".repeat(40);
const PR_SHA = "d".repeat(40);

let srv, port, dir;
let M;
const reset = () => (M = { statuses: [], failStatus: false, failMain: false, hangMain: false, prs: [] });

before(async () => {
  reset();
  srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "bad credentials" });
      const p = url.pathname;
      if (p === "/repos/kkarnati1980/devos/pulls") return send(200, M.prs);
      if (p === "/repos/kkarnati1980/devos/commits/main" && M.hangMain) return; // never answers
      if (p === "/repos/kkarnati1980/devos/commits/main") return M.failMain ? send(502, {}) : send(200, { sha: MAIN });
      if (p === "/repos/kkarnati1980/devos/actions/runs") return send(200, { workflow_runs: [{ workflow_id: 1, created_at: "2026-11-11T00:00:00Z", status: "in_progress", conclusion: null }] });
      const st = p.match(/^\/repos\/kkarnati1980\/devos\/statuses\/([0-9a-f]{40})$/);
      if (st && req.method === "POST") {
        if (M.failStatus) return send(500, {});
        M.statuses.push({ sha: st[1], ...JSON.parse(body) });
        return send(201, {});
      }
      send(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  fs.writeFileSync(path.join(dir, "github-review.env"), `GITHUB_REVIEW_TOKEN=${TOKEN}\n`, { mode: 0o600 });
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function tick(args = [], env = {}) {
  return new Promise((resolve) => {
    execFile("bash", [WATCH, ...args], {
      env: { ...process.env, GITHUB_API: `http://127.0.0.1:${port}`, DEVOS_DIR: dir, REVIEW_RUNNER: "/bin/false", ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}
const beats = () => M.statuses.filter((s) => s.context === "codex-review-watch");
const LAST = () => path.join(dir, "watch", "heartbeat.last");
const clear = () => fs.rmSync(LAST(), { force: true });

test("HB1 a tick posts one heartbeat on main with counts; the next tick within the interval posts none", async () => {
  reset(); clear();
  M.prs = [{ number: 7, draft: false, head: { sha: PR_SHA }, body: "Review-Contract: docs/modules/M2.3.md" }];
  const r1 = await tick();
  assert.equal(r1.code, 0, r1.out);
  assert.equal(beats().length, 1);
  assert.equal(beats()[0].sha, MAIN);
  assert.equal(beats()[0].state, "success");
  assert.match(beats()[0].description, /^alive at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, 1 open PRs, 1 waiting for green CI$/);
  assert.ok(!r1.out.includes(TOKEN));
  const r2 = await tick();
  assert.equal(r2.code, 0, r2.out);
  assert.equal(beats().length, 1, "no second heartbeat inside the interval");
  fs.writeFileSync(LAST(), String(Math.floor(Date.now() / 1000) - 3601));
  const r3 = await tick();
  assert.equal(r3.code, 0);
  assert.equal(beats().length, 2, "a new heartbeat once the default interval has passed");
  fs.writeFileSync(LAST(), "9999999999");
  await tick();
  assert.equal(beats().length, 3, "a future timestamp never silences the heartbeat");
});

test("HB2 a failed heartbeat never fails the tick and is retried on the next one", async () => {
  reset(); clear();
  M.failStatus = true;
  const r1 = await tick();
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /heartbeat: post failed; will retry/);
  assert.equal(fs.existsSync(LAST()), false);
  assert.ok(!r1.out.includes(TOKEN));
  M.failStatus = false; M.failMain = true;
  const r2 = await tick();
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /heartbeat: cannot read main/);
  assert.equal(fs.existsSync(LAST()), false);
  M.failMain = false; M.hangMain = true;
  const t0 = Date.now();
  const r3 = await tick([], { GH_TIMEOUT: "2" });
  assert.equal(r3.code, 0, r3.out);
  assert.ok(Date.now() - t0 < 15000, "a GitHub call that never answers is cut off");
  assert.match(r3.out, /heartbeat: cannot read main/);
  M.hangMain = false;
  await tick();
  assert.equal(beats().length, 1);
});

test("HB3 --dry-run posts nothing and writes no heartbeat state; the token never appears in output", async () => {
  reset(); clear();
  const r = await tick(["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WOULD post heartbeat/);
  assert.equal(M.statuses.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "watch", "heartbeat.last")), false);
  assert.ok(!r.out.includes(TOKEN));
});

// DEVOS-113 (review-watch v1.1.3, AT14): a page bigger than the kernel's 128 KiB per-argument limit is listed in full.
const AT14_HARNESS = `set -euo pipefail
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
log(){ echo "$*" >&2; }
gh_api(){ case "$2" in
  *pulls*page=1) jq -nc '[range(100) | {number: ., body: ("x" * 3000)}]';;
  *pulls*page=2) jq -nc '[range(5) | {number: (. + 100), body: "short"}]';;
  *runs*page=1) jq -nc '{workflow_runs: [range(100) | {id: ., pad: ("y" * 2000)}]}';;
  *runs*page=2) jq -nc '{workflow_runs: [range(3) | {id: (. + 100)}]}';;
  esac; }
eval "$(sed -n '/^gh_all() {/,/^}/p' scripts/review/review-watch.sh)"
p="$(gh_all "/repos/x/pulls?state=open" '')"
r="$(gh_all "/repos/x/actions/runs?head_sha=abc" workflow_runs)"
printf '%s %s %s\\n' "$(jq length <<<"$p")" "$(jq length <<<"$r")" "\${#p}"
`;

test("AT14: gh_all lists a page larger than 128 KiB in full (two pages, top-level and keyed)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const f = path.join(d, "h.sh");
  fs.writeFileSync(f, AT14_HARNESS);
  const [prs, runs, bytes] = execFileSync("bash", [f], { cwd: ROOT, encoding: "utf8" }).trim().split(" ").map(Number);
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(prs, 105);
  assert.equal(runs, 103);
  assert.ok(bytes > 131072, `first page must exceed 128 KiB, was ${bytes}`);
});

test("AT14: gh_all never passes page data as a jq argument", () => {
  const src = execFileSync("sed", ["-n", "/^gh_all() {/,/^}/p", "scripts/review/review-watch.sh"], { cwd: ROOT, encoding: "utf8" });
  assert.doesNotMatch(src, /--argjson|--arg /);
});
