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
const reset = () => (M = { statuses: [], failStatus: false, failMain: false, hangMain: false, prs: [], green: false, comments: [], runsDelayMs: 0, hangComment: false, failCommentsGet: false, manyComments: false });

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
      if (p === "/repos/kkarnati1980/devos/actions/runs") {
        if (M.runsDelayMs) { const d = M.runsDelayMs; return void setTimeout(() => send(200, { workflow_runs: [{ workflow_id: 1, created_at: "2026-11-11T00:00:00Z", status: "completed", conclusion: "success" }] }), d); }
        return send(200, { workflow_runs: [M.green
          ? { workflow_id: 1, created_at: "2026-11-11T00:00:00Z", status: "completed", conclusion: "success" }
          : { workflow_id: 1, created_at: "2026-11-11T00:00:00Z", status: "in_progress", conclusion: null }] });
      }
      const cm = p.match(/^\/repos\/kkarnati1980\/devos\/issues\/(\d+)\/comments$/);
      if (cm && req.method === "POST") {
        M.comments.push({ pr: Number(cm[1]), user: { login: "kkarnati1980" }, ...JSON.parse(body) });
        if (M.hangComment) return; // GitHub stored it, but the answer never arrives
        return send(201, {});
      }
      if (cm && req.method === "GET") {
        if (M.failCommentsGet) return send(502, {});
        if (M.manyComments) return send(200, Array.from({ length: 100 }, () => ({ body: "x", user: { login: "someone" } }))); // every page full
        return send(200, M.comments.filter((c) => c.pr === Number(cm[1])).map((c) => ({ body: c.body, user: c.user })));
      }
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
  M.prs = [{ number: 7, draft: false, user: { login: "kkarnati1980" }, head: { sha: PR_SHA, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M2.3.md" }];
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

// DEVOS-115 (review-watch v1.2.0): the repo is public; only own-repo PRs by an allowed author are reviewed.
const trustHarness = (authors) => `set -euo pipefail
REPO="kkarnati1980/devos"
${authors === undefined ? "" : `REVIEW_AUTHORS="${authors}"`}
log(){ echo "$*" >&2; }
eval "$(sed -n '/^REVIEW_AUTHORS=/p; /^trusted_pr() {/,/^}/p' scripts/review/review-watch.sh)"
while IFS= read -r pr; do if printf '%s' "$pr" | trusted_pr; then echo yes; else echo no; fi; done
`;
const pr = (login, repo) => JSON.stringify({ number: 1, user: login === null ? null : { login }, head: { sha: "a".repeat(40), repo: repo === null ? null : { full_name: repo } } });
const trust = (authors, prs) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rw-"));
  const f = path.join(d, "t.sh");
  fs.writeFileSync(f, trustHarness(authors));
  return execFileSync("bash", [f], { cwd: ROOT, encoding: "utf8", input: prs.join("\n") + "\n" }).trim().split("\n");
};

test("AT18: only PRs whose head is in kkarnati1980/devos and whose author is allowed are trusted", () => {
  const got = trust(undefined, [
    pr("kkarnati1980", "kkarnati1980/devos"),       // own PR: reviewed
    pr("kkarnati1980", "kkarnati1980/devos-fork"),  // own fork: not
    pr("mallory", "mallory/devos"),                 // stranger's fork
    pr("mallory", "kkarnati1980/devos"),            // stranger with push access: not on the list
    pr("kkarnati1980", null),                       // deleted head repo
    pr(null, "kkarnati1980/devos"),                 // no author
    pr("kkarnati19800", "kkarnati1980/devos"),      // prefix/suffix of an allowed login
    pr("kkarnati", "kkarnati1980/devos"),
  ]);
  assert.deepEqual(got, ["yes", "no", "no", "no", "no", "no", "no", "no"]);
});

test("AT18: REVIEW_AUTHORS extends the allow-list; a login with spaces or symbols never matches", () => {
  const got = trust("kkarnati1980 helper-bot", [pr("helper-bot", "kkarnati1980/devos"), pr("kkarnati1980 helper-bot", "kkarnati1980/devos"), pr("helper", "kkarnati1980/devos")]);
  assert.deepEqual(got, ["yes", "no", "no"]);
});

test("AT18: the main loop checks trust before draft, publication, stored-verdict and review steps", () => {
  const src = execFileSync("sed", ["-n", '/^for i in /,/^done/p', "scripts/review/review-watch.sh"], { cwd: ROOT, encoding: "utf8" });
  const at = (s) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  const t = at("trusted_pr");
  // v1.4.0 (DEVOS-116): the loop queues review candidates (`cands+=`); the runner runs only on a queued candidate.
  for (const later of ['"$draft" == "true"', "published \"$sha\"", '"$STATE/$sha.msg"', '"$VDIR/$sha.json"', "cands+="]) assert.ok(t < at(later), later);
  assert.ok(!src.includes("$RUNNER"), "the runner is never called inside the PR loop");
  const all = fs.readFileSync(WATCH, "utf8");
  assert.equal((all.match(/"\$RUNNER"/g) || []).length, 1, "one runner call site");
  assert.match(all, /review_one "\$pr" "\$sha" "\$contract" <\/dev\/null\n[\s\S]*done < <\(printf '%s\\n' "\$\{cands\[@\]\}"/);
  assert.match(src, /external PR, not reviewed/);
});

// DEVOS-116 (review-watch v1.4.0, AT19): the longest-waiting green head is reviewed first, not the newest PR.
test("AT19: with three green waiting heads, the one green longest is reviewed first, then the next", async () => {
  reset();
  M.green = true;
  const sha = (c) => c.repeat(40);
  const pr = (n, c) => ({ number: n, draft: false, user: { login: "kkarnati1980" }, head: { sha: sha(c), repo: { full_name: "kkarnati1980/devos" } }, body: `Review-Contract: docs/modules/M${n}.md` });
  M.prs = [pr(9, "a"), pr(8, "b"), pr(7, "e")]; // GitHub's order: newest PR first
  const ws = path.join(dir, "watch");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(dir, "verdicts"), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(ws, `${sha("b")}.green`), String(now - 3000)); // #8 waited longest
  fs.writeFileSync(path.join(ws, `${sha("e")}.green`), String(now - 2000));
  // #9 has no stored time: first seen green now.
  const log = path.join(dir, "runner.log");
  const runner = path.join(dir, "runner.sh");
  fs.writeFileSync(runner, `#!/usr/bin/env bash\necho "$2" >> "${log}"\nprintf '{"verdict":"PASS","summary":"ok","findings":[]}' > "${dir}/verdicts/$2.json"\n`, { mode: 0o755 });
  const order = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
  const r1 = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(r1.code, 0, r1.out);
  assert.deepEqual(order(), [sha("b")], "one review per tick, the oldest green head first");
  assert.match(r1.out, /PR #7 eeeeeee: queued for the next tick/);
  assert.match(r1.out, /PR #9 aaaaaaa: queued for the next tick/);
  assert.ok(fs.existsSync(path.join(ws, `${sha("a")}.green`)), "first-green time stored for the new head");
  await tick([], { REVIEW_RUNNER: runner });
  await tick([], { REVIEW_RUNNER: runner });
  assert.deepEqual(order(), [sha("b"), sha("e"), sha("a")]);
  assert.ok(M.statuses.some((x) => x.sha === sha("b") && x.context === "codex-review" && x.state === "success"));
  // --dry-run names the same choice and stores nothing.
  reset(); M.green = true; M.prs = [pr(12, "1"), pr(11, "2")];
  const r = await tick(["--dry-run"], { REVIEW_RUNNER: runner });
  assert.match(r.out, /PR #11 2222222: WOULD review/, "a tie on the first-green time goes to the lower PR number");
  assert.match(r.out, /PR #12 1111111: queued/);
  assert.equal(fs.existsSync(path.join(ws, `${sha("1")}.green`)), false);
  // Pre-review 1: heads first seen green in one slow tick (each CI read takes > 1 s) all get the tick's time, so
  // the lower PR number still wins; a future first-green time (clock stepped back) is reset to now.
  reset(); M.green = true; M.runsDelayMs = 1100; M.prs = [pr(22, "3"), pr(21, "4")];
  fs.writeFileSync(path.join(ws, `${sha("3")}.green`), String(now + 86400));
  const r5 = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(r5.code, 0, r5.out);
  assert.equal(order().at(-1), sha("4"), "PR #21 (lower number) first despite being listed and timed second");
  assert.equal(fs.readFileSync(path.join(ws, `${sha("3")}.green`), "utf8").trim(), fs.readFileSync(path.join(ws, `${sha("4")}.green`), "utf8").trim());
});

// DEVOS-106 (review-watch v1.4.1, AT20): a comment POST that GitHub completes after our timeout is not posted again.
test("AT20: a timed-out verdict comment that GitHub stored is found on the next tick and not posted twice", async () => {
  reset();
  M.green = true; M.hangComment = true;
  const sha = "f".repeat(40);
  M.prs = [{ number: 31, draft: false, user: { login: "kkarnati1980" }, head: { sha, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M31.md" }];
  fs.mkdirSync(path.join(dir, "verdicts"), { recursive: true });
  const runner = path.join(dir, "runner20.sh");
  fs.writeFileSync(runner, `#!/usr/bin/env bash\nprintf '{"verdict":"PASS","summary":"ok","findings":[]}' > "${dir}/verdicts/$2.json"\n`, { mode: 0o755 });
  const r1 = await tick([], { REVIEW_RUNNER: runner, GH_TIMEOUT: "2" });
  assert.equal(r1.code, 0, r1.out);
  assert.match(r1.out, /comment failed; will retry/);
  assert.equal(M.comments.length, 1);
  M.hangComment = false;
  // The comment read fails: no POST this tick (that would risk the duplicate), and nothing marked posted.
  M.failCommentsGet = true;
  const rf = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(rf.code, 0, rf.out);
  assert.match(rf.out, /cannot check the PR's comments/);
  assert.equal(M.comments.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "watch", `${sha}.commented`)), false);
  M.failCommentsGet = false;
  const r2 = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /verdict comment already on the PR/);
  assert.equal(M.comments.length, 1, "no duplicate verdict comment");
  assert.ok(M.statuses.some((x) => x.sha === sha && x.context === "codex-review" && x.state === "success"));
  assert.ok(fs.existsSync(path.join(dir, "watch", `${sha}.published`)));
  // A comment that never reached GitHub is still retried.
  reset(); M.green = true;
  const sha2 = "9".repeat(40);
  M.prs = [{ number: 32, draft: false, user: { login: "kkarnati1980" }, head: { sha: sha2, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M32.md" }];
  fs.writeFileSync(path.join(dir, "watch", `${sha2}.msg`), "### Codex review PR32-r1 — **PASS**\n\n- **Commit:** `" + sha2 + "`\n");
  fs.writeFileSync(path.join(dir, "watch", `${sha2}.state`), "success Codex PASS (PR32-r1)\n");
  fs.writeFileSync(path.join(dir, "watch", `${sha2}.comment-tried`), "");
  // A forged copy by another user, and our own comment for a different SHA, do not count.
  M.comments.push({ pr: 32, user: { login: "mallory" }, body: "### Codex review PR32-r1 — **PASS**\n\n- **Commit:** `" + sha2 + "`\n" });
  M.comments.push({ pr: 32, user: { login: "kkarnati1980" }, body: "### Codex review PR32-r1 — **PASS**\n\n- **Commit:** `" + "8".repeat(40) + "`\n" });
  const r3 = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(r3.code, 0, r3.out);
  assert.equal(M.comments.length, 3, "posted once: the forged and other-SHA comments did not count");
  assert.equal(M.comments.at(-1).user.login, "kkarnati1980");
});

test("AT20 (Codex PR52-r2): a runner-failure report carries the commit line and is not posted twice after a timed-out POST", async () => {
  reset();
  M.green = true; M.hangComment = true;
  const sha = "7".repeat(40);
  M.prs = [{ number: 33, draft: false, user: { login: "kkarnati1980" }, head: { sha, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M33.md" }];
  const failing = path.join(dir, "runner-fail.sh");
  fs.writeFileSync(failing, "#!/usr/bin/env bash\necho 'ERROR: Quota exceeded.'\nexit 1\n", { mode: 0o755 });
  // DEVOS-172: one attempt, so this run is the final one and posts the report (the retry cycle is AT21).
  const r1 = await tick([], { REVIEW_RUNNER: failing, GH_TIMEOUT: "2", REVIEW_RETRY_MAX: "1" });
  assert.equal(r1.code, 0, r1.out);
  assert.equal(M.comments.length, 1);
  assert.match(M.comments[0].body, /could not run \(exit 1\)/);
  assert.ok(M.comments[0].body.includes("- **Commit:** `" + sha + "`"));
  M.hangComment = false;
  const r2 = await tick([], { REVIEW_RUNNER: failing, REVIEW_RETRY_MAX: "1" });
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /verdict comment already on the PR/);
  assert.equal(M.comments.length, 1, "the failure report is not duplicated");
  assert.ok(M.statuses.some((x) => x.sha === sha && x.context === "codex-review" && x.state === "error"));
});

test("AT20 (Codex PR52-r5): a comment list that hits the 30-page cap is indeterminate, so the POST waits", async () => {
  reset();
  M.green = true; M.manyComments = true;
  const sha = "6".repeat(40);
  M.prs = [{ number: 34, draft: false, user: { login: "kkarnati1980" }, head: { sha, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M34.md" }];
  fs.writeFileSync(path.join(dir, "watch", `${sha}.msg`), "### Codex review PR34-r1 — **PASS**\n\n- **Commit:** `" + sha + "`\n");
  fs.writeFileSync(path.join(dir, "watch", `${sha}.state`), "success Codex PASS (PR34-r1)\n");
  fs.writeFileSync(path.join(dir, "watch", `${sha}.comment-tried`), "");
  const r = await tick();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cannot check the PR's comments/);
  assert.equal(M.comments.length, 0, "no POST on a truncated list");
  assert.equal(fs.existsSync(path.join(dir, "watch", `${sha}.commented`)), false);
});

// DEVOS-172 (review-watch v1.5.0, AT21): a review that could not run is retried with a bounded back-off.
test("AT21: a head whose review could not run is retried after a growing back-off; only the last attempt posts the report", async () => {
  reset();
  M.green = true;
  const sha = "5".repeat(40);
  M.prs = [{ number: 41, draft: false, user: { login: "kkarnati1980" }, head: { sha, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M41.md" }];
  const calls = path.join(dir, "calls41.log");
  const failing = path.join(dir, "runner-fail41.sh");
  fs.writeFileSync(failing, `#!/usr/bin/env bash\necho "$4" >> "${calls}"\necho 'ERROR: Quota exceeded.'\nexit 1\n`, { mode: 0o755 });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : []);
  const ws = path.join(dir, "watch");
  const RA = path.join(ws, `${sha}.retry_at`);
  const st = () => M.statuses.filter((x) => x.sha === sha && x.context === "codex-review");
  const now = () => Math.floor(Date.now() / 1000);

  const t1 = now();
  const r1 = await tick([], { REVIEW_RUNNER: failing });
  assert.equal(r1.code, 0, r1.out);
  assert.deepEqual(runs(), ["PR41-r1"]);
  assert.equal(M.comments.length, 0, "no report after a non-final attempt");
  assert.equal(st().at(-1).state, "pending");
  assert.match(st().at(-1).description, /could not run \(attempt 1 of 3\); retry in 10 min/);
  assert.equal(fs.readFileSync(path.join(ws, `${sha}.fails`), "utf8").trim(), "1");
  const ra1 = Number(fs.readFileSync(RA, "utf8"));
  assert.ok(ra1 >= t1 + 600 && ra1 <= now() + 600, "first back-off is 600 s");
  assert.equal(fs.existsSync(path.join(ws, `${sha}.pr`)), false, "the round number is not used up");
  assert.equal(fs.existsSync(path.join(ws, `${sha}.msg`)), false);

  const r2 = await tick([], { REVIEW_RUNNER: failing });
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /PR #41 5555555: review could not run earlier; retry after/);
  assert.equal(runs().length, 1, "no retry before the back-off has passed");

  fs.writeFileSync(RA, String(now() - 1));
  const t3 = now();
  await tick([], { REVIEW_RUNNER: failing });
  assert.deepEqual(runs(), ["PR41-r1", "PR41-r1"], "the retry keeps the label");
  const ra2 = Number(fs.readFileSync(RA, "utf8"));
  assert.ok(ra2 >= t3 + 1200 && ra2 <= now() + 1200, "the back-off doubles");
  assert.match(st().at(-1).description, /attempt 2 of 3/);

  fs.writeFileSync(RA, String(now() - 1));
  await tick([], { REVIEW_RUNNER: failing });
  assert.equal(runs().length, 3);
  assert.equal(M.comments.length, 1, "the last attempt posts the report");
  assert.match(M.comments[0].body, /PR41-r1 — could not run \(exit 1\)/);
  assert.match(M.comments[0].body, /- \*\*Attempts:\*\* 3 of 3/);
  assert.equal(st().at(-1).state, "error");
  await tick([], { REVIEW_RUNNER: failing });
  assert.equal(runs().length, 3, "never retried after the last attempt");
  assert.equal(M.comments.length, 1);
});

test("AT21: a retry that succeeds publishes the verdict with the first attempt's label; a retry time beyond the cap never blocks", async () => {
  reset();
  M.green = true;
  const sha = "0".repeat(40);
  M.prs = [{ number: 42, draft: false, user: { login: "kkarnati1980" }, head: { sha, repo: { full_name: "kkarnati1980/devos" } }, body: "Review-Contract: docs/modules/M42.md" }];
  fs.mkdirSync(path.join(dir, "verdicts"), { recursive: true });
  const flag = path.join(dir, "fail-once42");
  fs.writeFileSync(flag, "");
  const runner = path.join(dir, "runner42.sh");
  fs.writeFileSync(runner, `#!/usr/bin/env bash\nif [[ -e "${flag}" ]]; then rm -f "${flag}"; echo 'ERROR: Quota exceeded.'; exit 1; fi\nprintf '{"verdict":"PASS","summary":"ok","findings":[]}' > "${dir}/verdicts/$2.json"\n`, { mode: 0o755 });
  const ws = path.join(dir, "watch");
  await tick([], { REVIEW_RUNNER: runner, REVIEW_RETRY_BASE: "60" });
  const ra = Number(fs.readFileSync(path.join(ws, `${sha}.retry_at`), "utf8"));
  assert.ok(ra - Math.floor(Date.now() / 1000) <= 60, "REVIEW_RETRY_BASE sets the first back-off");
  // A value far beyond the cap (clock stepped back, or a bad file) is treated as due.
  fs.writeFileSync(path.join(ws, `${sha}.retry_at`), String(Math.floor(Date.now() / 1000) + 99999));
  const r = await tick([], { REVIEW_RUNNER: runner });
  assert.equal(r.code, 0, r.out);
  assert.equal(M.comments.length, 1);
  assert.match(M.comments[0].body, /^### Codex review PR42-r1 — \*\*PASS\*\*/);
  assert.ok(M.statuses.some((x) => x.sha === sha && x.context === "codex-review" && x.state === "success"));
  assert.ok(fs.existsSync(path.join(ws, `${sha}.published`)));
});
