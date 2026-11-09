// DEVOS-74 server agent: AT1–AT9 against a mock GitHub API, a mock Coolify API and a local git remote.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const AGENT = path.join(ROOT, "scripts/server/server-agent.sh");
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const CF_TOKEN = "7|coolifySecretValue0123456789xyz";
const SK = "sk-proj-" + "abcdefghijklmnop1234";

let srv, port, tmp, bare;
let M; // mock state
const reqs = [];

function resetMock() {
  M = { main: null, runs: {}, statuses: {}, pulls: {}, trees: {}, failStatus: 0, deployPatch: [], deployStatus: "finished",
    envs: [{ key: "DEVOS_BIND_IP", value: "100.64.0.1", is_preview: false, is_buildtime: true, is_runtime: true }], failEnv: 0, runtimeOnly: false, envPatch: null,
    cfPerms: "read write deploy", appSha: "HEAD" };
  reqs.length = 0;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

// Make a commit on the bare remote's main with the given files; returns its sha.
function commit(files, msg = "c") {
  const w = path.join(tmp, "author");
  if (!fs.existsSync(w)) { git(tmp, "clone", "-q", bare, w); git(w, "checkout", "-q", "-B", "main"); }
  for (const [p, c] of Object.entries(files)) {
    const f = path.join(w, p);
    if (c === null) { fs.rmSync(f, { force: true }); continue; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  }
  git(w, "add", "-A");
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  git(w, "push", "-q", "origin", "HEAD:main");
  const sha = git(w, "rev-parse", "HEAD");
  M.trees[sha] = git(w, "rev-parse", "HEAD^{tree}");
  return sha;
}

const real = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const baseFiles = () => ({
  "scripts/review/review-watch.sh": real("scripts/review/review-watch.sh"),
  "scripts/review/review-commit.sh": real("scripts/review/review-commit.sh"),
  "scripts/server/server-agent.sh": real("scripts/server/server-agent.sh"),
  "scripts/server/install-server-agent.sh": real("scripts/server/install-server-agent.sh"),
  "scripts/server/checks/ok.sh": "#!/usr/bin/env bash\necho fine\n",
  "scripts/server/checks/leaky.sh": `#!/usr/bin/env bash\necho "key ${SK} token ${GH_TOKEN} cf ${CF_TOKEN}"\nexit 1\n`,
});

const green = (sha) => { M.runs[sha] = [{ workflow_id: 1, created_at: "2026-11-06T00:00:00Z", status: "completed", conclusion: "success" }]; };
const pass = (sha) => { (M.statuses[sha] ||= []).push({ context: "codex-review", state: "success", created_at: "2026-11-06T00:00:01Z" }); };

function handler(req, res) {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    reqs.push({ method: req.method, path: p, auth: req.headers.authorization || "", body });
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    let m;
    if (p === "/gh/repos/kkarnati1980/devos/commits/main") return json(200, { sha: M.main });
    if ((m = p.match(/^\/gh\/repos\/kkarnati1980\/devos\/actions\/runs$/))) {
      const all = M.runs[u.searchParams.get("head_sha")] || [];
      const pg = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page") || 30);
      return json(200, { workflow_runs: all.slice((pg - 1) * per, pg * per) });
    }
    if ((m = p.match(/^\/gh\/repos\/kkarnati1980\/devos\/commits\/([0-9a-f]{40})\/status$/))) return json(200, { statuses: [...(M.statuses[m[1]] || [])].reverse() });
    if ((m = p.match(/^\/gh\/repos\/kkarnati1980\/devos\/commits\/([0-9a-f]{40})\/pulls$/))) return json(200, M.pulls[m[1]] || []);
    if ((m = p.match(/^\/gh\/repos\/kkarnati1980\/devos\/git\/commits\/([0-9a-f]{40})$/))) return M.failTree ? json(500, {}) : json(200, { tree: { sha: M.trees[m[1]] } });
    if ((m = p.match(/^\/gh\/repos\/kkarnati1980\/devos\/statuses\/([0-9a-f]{40})$/))) {
      if (M.failStatus > 0) { M.failStatus--; return json(502, {}); }
      return json(201, {});
    }
    if (p.match(/^\/gh\/repos\/kkarnati1980\/devos\/(issues\/\d+|commits\/[0-9a-f]{40})\/comments$/)) return json(201, {});
    if ((m = p.match(/^\/cf\/applications\/([\w-]+)\/envs$/)) && req.method === "GET") {
      {
        const patch = M.envPatch || (M.runtimeOnly ? { is_buildtime: false } : null);
        return json(200, patch ? M.envs.map((e) => (e.key === "GIT_SHA" ? { ...e, ...patch } : e)) : M.envs);
      }
    }
    if ((m = p.match(/^\/cf\/applications\/([\w-]+)\/envs\/bulk$/)) && req.method === "PATCH") {
      if (M.failEnv > 0) { M.failEnv--; return json(403, { message: "forbidden" }); }
      // Mock Coolify bulk upsert: update the non-preview variable with this key, or create it.
      for (const e of JSON.parse(body).data) {
        const i = M.envs.findIndex((x) => x.key === e.key && !x.is_preview);
        if (i >= 0) M.envs[i] = { ...M.envs[i], ...e }; else M.envs.push(e);
      }
      return json(201, {});
    }
    if ((m = p.match(/^\/cf\/applications\/([\w-]+)$/)) && req.method === "GET") {
      if (!M.cfPerms.split(" ").includes("read")) return json(403, { message: "forbidden" });
      return json(200, { uuid: m[1], name: "devos", git_commit_sha: M.appSha });
    }
    if ((m = p.match(/^\/cf\/applications\/([\w-]+)$/)) && req.method === "PATCH") {
      // Mock Coolify: PATCH on an application needs the token's write permission (DEVOS-82).
      if (!M.cfPerms.split(" ").includes("write")) return json(403, { message: "This action is unauthorized." });
      const b = JSON.parse(body); M.deployPatch.push(b);
      if (typeof b.git_commit_sha === "string") M.appSha = b.git_commit_sha;
      return json(200, {});
    }
    if (p === "/cf/deploy") M.deployPosts = (M.deployPosts || 0) + 1;
    if (p === "/cf/deploy") return json(200, { deployments: [{ deployment_uuid: "dep-1234abcd" }] });
    if (p === "/cf/deployments/dep-1234abcd") return json(200, { status: M.deployStatus });
    json(404, { p });
  });
}

function runAgent(extra = {}, args = []) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GITHUB_API: `http://127.0.0.1:${port}/gh`, COOLIFY_API: `http://127.0.0.1:${port}/cf`,
      DEVOS_DIR: path.join(tmp, ".devos"), AGENT_WORK: path.join(tmp, "work"), AGENT_REPO_URL: bare,
      GIT_SSH_COMMAND: "ssh", POLL_SEC: "0", ...extra,
    };
    const ch = spawn("bash", [AGENT, ...args], { env });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (out += d));
    ch.on("close", (code) => resolve({ code, out }));
  });
}
const writes = () => reqs.filter((r) => r.method !== "GET");
const statusPosts = (ctx) => writes().filter((r) => r.path.includes("/statuses/") && JSON.parse(r.body).context === ctx).map((r) => JSON.parse(r.body));
const D = () => path.join(tmp, ".devos");

function freshState({ deploy = false } = {}) {
  fs.rmSync(D(), { recursive: true, force: true });
  fs.mkdirSync(path.join(D(), "agent"), { recursive: true });
  fs.writeFileSync(path.join(D(), "github-review.env"), `GITHUB_REVIEW_TOKEN=${GH_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(D(), "coolify-deploy.env"), `COOLIFY_TOKEN=${CF_TOKEN}\nCOOLIFY_APP_UUID=app-uuid-1234\n`, { mode: 0o600 });
  if (deploy) fs.writeFileSync(path.join(D(), "agent/deploy.enabled"), "x");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-agent-"));
  bare = path.join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", bare);
  srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
});
after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("AT1/AT9: passing SHA installs the allow-list only; a second tick makes no writes", async () => {
  resetMock(); freshState();
  const sha = commit(baseFiles(), "base");
  M.main = sha; green(sha); pass(sha);
  const r = await runAgent();
  assert.equal(r.code, 0, r.out);
  for (const f of ["review-watch.sh", "review-commit.sh", "server-agent.sh", "checks/ok.sh", "checks/leaky.sh"]) assert.ok(fs.existsSync(path.join(D(), "bin", f)), f);
  assert.ok(!fs.existsSync(path.join(D(), "bin/install-server-agent.sh")), "installer is not on the allow-list");
  assert.equal(fs.readFileSync(path.join(D(), "agent/installed.sha"), "utf8").trim(), sha);
  assert.ok(fs.existsSync(path.join(D(), `agent/done.${sha}`)), "SHA reaches done");
  assert.equal(M.deployPatch.length, 0, "deploy disabled: Coolify never called (AT4)");
  assert.ok(!reqs.some((q) => q.path.startsWith("/cf/")), "no Coolify request at all");
  const sc = statusPosts("server-check");
  assert.equal(sc.length, 1); assert.equal(sc[0].state, "failure"); assert.match(sc[0].description, /1\/2 passed/);
  reqs.length = 0;
  const r2 = await runAgent();
  assert.equal(r2.code, 0); assert.equal(writes().length, 0, "AT9: no writes on a handled SHA");
});

test("AT3: a SHA without a PASS, or with red CI, is refused once", async () => {
  resetMock(); freshState({ deploy: true });
  const sha = commit({ "x.txt": "1" }, "nopass");
  M.main = sha; green(sha);
  await runAgent();
  assert.ok(!fs.existsSync(path.join(D(), "agent/installed.sha")), "nothing installed");
  assert.equal(M.deployPatch.length, 0);
  const st = statusPosts("devos-deploy");
  assert.equal(st.length, 1); assert.equal(st[0].state, "failure"); assert.match(st[0].description, /no Codex PASS/);
  reqs.length = 0; await runAgent(); assert.equal(writes().length, 0, "no repeat");

  const red = commit({ "x.txt": "2" }, "red");
  M.main = red; pass(red);
  M.runs[red] = [{ workflow_id: 1, created_at: "t", status: "completed", conclusion: "failure" }];
  reqs.length = 0; await runAgent();
  assert.match(statusPosts("devos-deploy")[0].description, /CI is not green/);
  assert.equal(M.deployPatch.length, 0);
});

test("AT2: merge commit accepted only when its tree equals the PASSed PR head's tree", async () => {
  resetMock(); freshState();
  const head = commit({ "y.txt": "head" }, "pr head");
  const merge = commit({}, "merge (same tree)");
  M.main = merge; green(merge); pass(head);
  M.pulls[merge] = [{ number: 42, merge_commit_sha: merge, merged_at: "t", head: { sha: head } }];
  await runAgent();
  assert.equal(fs.readFileSync(path.join(D(), "agent/installed.sha"), "utf8").trim(), merge);
  assert.ok(writes().some((q) => q.path.endsWith("/issues/42/comments")), "check comment on the merged PR (AT5)");

  const head2 = commit({ "z.txt": "head2" }, "pr2 head");
  const merge2 = commit({ "other.txt": "main moved" }, "merge brings other changes");
  M.main = merge2; green(merge2); pass(head2);
  M.pulls[merge2] = [{ number: 43, merge_commit_sha: merge2, merged_at: "t", head: { sha: head2 } }];
  reqs.length = 0; await runAgent();
  assert.match(statusPosts("devos-deploy")[0].description, /tree differs/);
  assert.equal(fs.readFileSync(path.join(D(), "agent/installed.sha"), "utf8").trim(), merge);
});

test("AT4/AT5/AT6/AT7: deploys the exact SHA, posts statuses, retries a failed post without redeploying, redacts", async () => {
  resetMock(); freshState({ deploy: true });
  const sha = commit({ "w.txt": String(Date.now()) }, "deployable");
  M.main = sha; green(sha); pass(sha);
  M.failStatus = 1; // the first status post (devos-deploy) fails
  const r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(M.deployPatch, [{ git_commit_sha: sha }]);
  const sc = statusPosts("server-check");
  assert.equal(sc.length, 1); assert.equal(sc[0].state, "failure");
  reqs.length = 0;
  const r2 = await runAgent();
  assert.equal(M.deployPatch.length, 1, "AT6: not redeployed");
  const dd = statusPosts("devos-deploy");
  assert.equal(dd.length, 1); assert.equal(dd[0].state, "success");
  assert.equal(statusPosts("server-check").length, 0, "checks not re-posted");
  reqs.length = 0; await runAgent(); assert.equal(writes().length, 0);
  // AT7: no secret in any post body or the agent output.
  const all = fs.readdirSync(path.join(D(), "agent")).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(D(), "agent", f), "utf8")).join("\n");
  assert.match(all, /\[redacted\]/);
  for (const s of [GH_TOKEN, CF_TOKEN, SK]) {
    assert.ok(!all.includes(s), "stored comment leaks a secret");
    assert.ok(!(r.out + r2.out).includes(s), "agent log leaks a secret");
  }
  for (const q of reqs) for (const s of [GH_TOKEN, CF_TOKEN, SK]) assert.ok(!q.body.includes(s));
});

test("AT8: a file failing bash -n blocks the whole install", async () => {
  resetMock(); freshState();
  const before = fs.existsSync(path.join(D(), "agent/installed.sha"));
  const sha = commit({ "scripts/server/checks/broken.sh": "#!/usr/bin/env bash\nif then fi (\n" }, "broken");
  M.main = sha; green(sha); pass(sha);
  await runAgent();
  assert.ok(!before && !fs.existsSync(path.join(D(), "agent/installed.sha")), "nothing installed");
  assert.ok(!fs.existsSync(path.join(D(), "bin/checks/broken.sh")));
  assert.match(statusPosts("devos-deploy")[0].description, /install failed/);
  commit({ "scripts/server/checks/broken.sh": null }, "fix");
});

test("AT2: an unreadable tree is a wait, never an accept or a refusal", async () => {
  resetMock(); freshState();
  const head = commit({ "t.txt": "h" }, "head");
  const merge = commit({}, "merge");
  M.main = merge; green(merge); pass(head); M.failTree = true;
  M.pulls[merge] = [{ number: 50, merge_commit_sha: merge, merged_at: "t", head: { sha: head } }];
  await runAgent();
  assert.ok(!fs.existsSync(path.join(D(), "agent/installed.sha")), "not installed");
  assert.equal(writes().length, 0, "no refusal posted");
  M.failTree = false; await runAgent();
  assert.equal(fs.readFileSync(path.join(D(), "agent/installed.sha"), "utf8").trim(), merge);
});

test("AT3: CI is judged across all pages of workflow runs", async () => {
  resetMock(); freshState();
  const sha = commit({ "p.txt": "pages" }, "many runs");
  M.main = sha; pass(sha);
  M.runs[sha] = Array.from({ length: 150 }, (_, i) => ({ workflow_id: 100 + i, created_at: "t", status: "completed", conclusion: "success" }));
  M.runs[sha][140].conclusion = "failure"; // on page 2
  await runAgent();
  assert.match(statusPosts("devos-deploy")[0].description, /CI is not green/);
});

test("AT6: a failed post is drained after main moves on; --dry-run never posts", async () => {
  resetMock(); freshState();
  const a = commit({ "d.txt": "a" }, "no pass a");
  M.main = a; green(a); M.failStatus = 1;
  await runAgent();
  assert.ok(!fs.existsSync(path.join(D(), `agent/refuse-statused.${a}`)), "first post failed");
  reqs.length = 0;
  const r = await runAgent({}, ["--dry-run"]);
  assert.equal(writes().length, 0, r.out);
  const b = commit({ "d.txt": "b" }, "no pass b");
  M.main = b; green(b);
  reqs.length = 0; await runAgent();
  const shas = writes().filter((q) => q.path.includes("/statuses/")).map((q) => q.path.split("/").pop());
  assert.ok(shas.includes(a), "old SHA's refusal drained"); assert.ok(shas.includes(b));
  assert.ok(fs.existsSync(path.join(D(), `agent/done.${a}`)));
});

test("AT4: a deploy is never submitted twice: resumed after a time-out, not resubmitted after an interruption", async () => {
  resetMock(); freshState({ deploy: true });
  const sha = commit({ "r.txt": "resume" }, "resume");
  M.main = sha; green(sha); pass(sha); M.deployStatus = "in_progress";
  await runAgent({ DEPLOY_TIMEOUT: "0" });
  assert.equal(M.deployPosts, 1); assert.equal(statusPosts("devos-deploy").length, 0);
  M.deployStatus = "finished";
  await runAgent();
  assert.equal(M.deployPosts, 1, "resumed, not resubmitted");
  assert.equal(statusPosts("devos-deploy").at(-1).state, "success");

  const s2 = commit({ "r.txt": "interrupted" }, "interrupted");
  M.main = s2; green(s2); pass(s2);
  fs.writeFileSync(path.join(D(), `agent/installed.${s2}`), "");
  fs.writeFileSync(path.join(D(), `agent/deploy-started.${s2}`), "");
  reqs.length = 0; await runAgent();
  assert.equal(M.deployPosts, 1, "no second submit");
  assert.equal(statusPosts("devos-deploy")[0].state, "failure");
});

test("AT4: an earlier SHA's in-flight deploy is finished and reported before the new main SHA deploys", async () => {
  resetMock(); freshState({ deploy: true });
  const a = commit({ "q.txt": "a" }, "deploy a");
  M.main = a; green(a); pass(a); M.deployStatus = "in_progress";
  await runAgent({ DEPLOY_TIMEOUT: "0" });
  assert.equal(M.deployPosts, 1);
  const b = commit({ "q.txt": "b" }, "deploy b");
  M.main = b; green(b); pass(b);
  reqs.length = 0; await runAgent({ DEPLOY_TIMEOUT: "0" });
  assert.equal(M.deployPosts, 1, "b waits while a is still running");
  M.deployStatus = "finished";
  reqs.length = 0; await runAgent();
  assert.equal(M.deployPosts, 2, "a resumed (no resubmit), then b submitted once");
  const dd = writes().filter((q) => q.path.includes("/statuses/") && JSON.parse(q.body).context === "devos-deploy");
  assert.deepEqual(dd.map((q) => [q.path.split("/").pop(), JSON.parse(q.body).state]), [[a, "success"], [b, "success"]]);
  assert.ok(fs.existsSync(path.join(D(), `agent/done.${a}`)));
});

test("AT6: --dry-run on a fresh server creates no directories or lock file", async () => {
  resetMock(); freshState();
  fs.rmSync(path.join(D(), "agent"), { recursive: true, force: true });
  const sha = commit({ "dr.txt": "x" }, "dry");
  M.main = sha; green(sha); pass(sha);
  const r = await runAgent({}, ["--dry-run"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(D(), "agent")) && !fs.existsSync(path.join(D(), "bin")), "nothing created");
  assert.equal(writes().length, 0);
  assert.match(r.out, /WOULD install/);
});

test("AT4: an earlier deployment's status must post before the newer SHA deploys", async () => {
  resetMock(); freshState({ deploy: true });
  const a = commit({ "o.txt": "a" }, "order a");
  M.main = a; green(a); pass(a); M.deployStatus = "in_progress";
  await runAgent({ DEPLOY_TIMEOUT: "0" });
  const b = commit({ "o.txt": "b" }, "order b");
  M.main = b; green(b); pass(b); M.deployStatus = "finished"; M.failStatus = 1;
  await runAgent();
  assert.equal(M.deployPosts, 1, "b not submitted while a's status is unposted");
  assert.ok(!fs.existsSync(path.join(D(), `agent/deploy-statused.${a}`)));
  await runAgent();
  assert.ok(fs.existsSync(path.join(D(), `agent/deploy-statused.${a}`)));
  assert.equal(M.deployPosts, 2, "then b submitted once");
});

test("AT4: a running deployment is reconciled after deploy is turned off; nothing new is submitted", async () => {
  resetMock(); freshState({ deploy: true });
  const sha = commit({ "off.txt": "x" }, "deploy then off");
  M.main = sha; green(sha); pass(sha); M.deployStatus = "in_progress";
  await runAgent({ DEPLOY_TIMEOUT: "0" });
  fs.rmSync(path.join(D(), "agent/deploy.enabled"));
  reqs.length = 0; await runAgent({ DEPLOY_TIMEOUT: "0" });
  assert.equal(statusPosts("server-check").length, 0, "no checks while the deployment runs");
  assert.ok(!fs.existsSync(path.join(D(), `agent/done.${sha}`)));
  M.deployStatus = "finished";
  reqs.length = 0; await runAgent();
  assert.equal(M.deployPosts, 1, "never resubmitted");
  assert.equal(statusPosts("devos-deploy")[0].state, "success");
  assert.equal(statusPosts("server-check").length, 1, "checks after the deployment finished");
});

// DEVOS-83: GIT_SHA reaches the Coolify build. The env upsert happens before the deploy is submitted, holds
// the exact SHA as build-time and runtime, and a failed upsert submits nothing (retried next tick).
const cfOrder = () => reqs.filter((q) => q.path.startsWith("/cf/") && q.method !== "GET").map((q) => `${q.method} ${q.path}`);
const gitSha = () => M.envs.filter((e) => e.key === "GIT_SHA");

test("DEVOS-83: GIT_SHA=<sha> is upserted build-time + runtime after git_commit_sha and before the deploy", async () => {
  resetMock(); freshState({ deploy: true });
  M.envs.push({ key: "GIT_SHA", value: "old", is_preview: false, is_buildtime: false, is_runtime: true });
  const sha = commit({ ...baseFiles(), "x83a": "1" }, "devos-83 a");
  M.main = sha; green(sha); pass(sha);
  const r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(cfOrder(), ["PATCH /cf/applications/app-uuid-1234", "PATCH /cf/applications/app-uuid-1234/envs/bulk", "POST /cf/deploy"]);
  assert.equal(gitSha().length, 1, "updated in place, not duplicated");
  assert.equal(gitSha()[0].value, sha);
  assert.equal(gitSha()[0].is_buildtime, true);
  assert.equal(gitSha()[0].is_runtime, true);
  assert.equal(statusPosts("devos-deploy")[0].state, "success");
  assert.ok(!r.out.includes(CF_TOKEN));
});

test("DEVOS-83: an older Coolify (is_build_time) gets that flag name", async () => {
  resetMock(); freshState({ deploy: true });
  M.envs = [{ key: "DEVOS_BIND_IP", value: "100.64.0.1", is_preview: false, is_build_time: true }];
  const sha = commit({ ...baseFiles(), "x83b": "1" }, "devos-83 b");
  M.main = sha; green(sha); pass(sha);
  const r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(gitSha(), [{ key: "GIT_SHA", value: sha, is_preview: false, is_build_time: true }]);
  assert.equal(M.deployPosts, 1);
});

test("DEVOS-83: a failed GIT_SHA upsert starts no deploy; the next tick retries and deploys once", async () => {
  resetMock(); freshState({ deploy: true });
  M.failEnv = 1;
  const sha = commit({ ...baseFiles(), "x83c": "1" }, "devos-83 c");
  M.main = sha; green(sha); pass(sha);
  let r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.equal(M.deployPosts || 0, 0, "no deploy submitted");
  assert.ok(!fs.existsSync(path.join(D(), `agent/deploy-started.${sha}`)), "no start marker, so it is not an unknown outcome");
  assert.equal(statusPosts("devos-deploy").length, 0, "no failure recorded");
  assert.match(r.out, /could not set GIT_SHA/);
  r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.equal(M.deployPosts, 1, "deployed once on the retry");
  assert.equal(gitSha()[0].value, sha);
  assert.equal(statusPosts("devos-deploy")[0].state, "success");
});

test("DEVOS-83: a GIT_SHA that does not read back as build-time starts no deploy", async () => {
  resetMock(); freshState({ deploy: true });
  const sha = commit({ ...baseFiles(), "x83d": "1" }, "devos-83 d");
  M.main = sha; green(sha); pass(sha);
  M.runtimeOnly = true; // a Coolify that accepts the write but keeps the variable runtime-only
  const r = await runAgent();
  assert.equal(r.code, 0, r.out);
  assert.equal(M.deployPosts || 0, 0);
  assert.match(r.out, /did not read back/);
  assert.ok(!fs.existsSync(path.join(D(), `agent/deploy-started.${sha}`)));
});

// Codex PR22-r1: jq's // replaced an explicit false, so is_runtime:false read back as runtime.
for (const [name, patch] of [
  ["is_runtime: false", { is_runtime: false }],
  ["is_buildtime: false with a stale is_build_time: true", { is_buildtime: false, is_build_time: true }],
]) {
  test(`DEVOS-83 (PR22-r1): a GIT_SHA read back with ${name} starts no deploy`, async () => {
    resetMock(); freshState({ deploy: true });
    const sha = commit({ ...baseFiles(), [`x83r-${name.length}`]: "1" }, `devos-83 r1 ${name}`);
    M.main = sha; green(sha); pass(sha);
    M.envPatch = patch;
    const r = await runAgent();
    assert.equal(r.code, 0, r.out);
    assert.equal(M.deployPosts || 0, 0, "no deploy submitted");
    assert.match(r.out, /did not read back/);
    assert.ok(!fs.existsSync(path.join(D(), `agent/deploy-started.${sha}`)), "no start marker");
  });
}

// DEVOS-83: dashboard-tailnet-only requires a verified HTTPS handshake on the MagicDNS name; plain HTTP fails.
// Fakes on PATH: tailscale (ip / status --json), hostname -I, curl (handshake result), and timeout, which
// answers the check's TCP connect probes from FAKE_OPEN and runs every other command unchanged.
const TCHECK = path.join(ROOT, "scripts/server/checks/dashboard-tailnet-only.sh");
function runTailnetCheck({ open = "100.64.0.7", curlRc = 0, curlOut = "200", dns = "devos.tail1234.ts.net." } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "devos-tcheck-"));
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  w("tailscale", `if [[ "$1" == ip ]]; then echo 100.64.0.7; else printf '%s' "$FAKE_TS_JSON"; fi`);
  w("hostname", "echo 100.64.0.7 10.0.0.5 203.0.113.9");
  w("curl", `echo "$*" > "$FAKE_DIR/curl.args"; printf '%s' "$FAKE_CURL_OUT"; exit "$FAKE_CURL_RC"`);
  w("timeout", `shift; if [[ "$1" == bash && "$2" == -c ]]; then [[ " $FAKE_OPEN " == *" $4 "* ]]; exit $?; fi; exec "$@"`);
  const r = execFileSync("bash", ["-c", `bash "${TCHECK}"; echo "rc=$?"`], {
    env: { PATH: `${bin}:${process.env.PATH}`, DEVOS_DIR: bin, FAKE_DIR: bin, FAKE_OPEN: open, FAKE_CURL_RC: String(curlRc),
           FAKE_CURL_OUT: curlOut, FAKE_TS_JSON: JSON.stringify({ Self: { DNSName: dns } }) },
    encoding: "utf8",
  });
  const args = fs.existsSync(path.join(bin, "curl.args")) ? fs.readFileSync(path.join(bin, "curl.args"), "utf8") : "";
  return { code: Number(r.match(/rc=(\d+)\s*$/)[1]), out: r, args };
}

test("DEVOS-83 dashboard-tailnet-only: pass on a verified HTTPS handshake on the MagicDNS name, pinned to the tailnet IP", () => {
  const r = runTailnetCheck();
  assert.equal(r.code, 0, r.out);
  assert.match(r.args, /https:\/\/devos\.tail1234\.ts\.net:3000\//);
  assert.match(r.args, /--resolve devos\.tail1234\.ts\.net:3000:100\.64\.0\.7/);
  assert.doesNotMatch(r.args, /(^|\s)(-k|--insecure)(\s|$)/, "certificate verification is never turned off");
  assert.match(r.out, /203\.0\.113\.9:3000 -> refused \(ok\)/);
});

test("DEVOS-83 dashboard-tailnet-only: plain HTTP or a bad certificate fails", () => {
  const plain = runTailnetCheck({ curlRc: 35, curlOut: "000curl: (35) OpenSSL/3.0: error:0A00010B:SSL routines::wrong version number" });
  assert.equal(plain.code, 1, plain.out);
  assert.match(plain.out, /no valid HTTPS \(curl exit 35/);
  assert.equal(runTailnetCheck({ curlRc: 60, curlOut: "000curl: (60) SSL certificate problem" }).code, 1);
});

test("DEVOS-83 dashboard-tailnet-only: skipped while nothing answers; fails without a MagicDNS name or when a public IP accepts", () => {
  assert.equal(runTailnetCheck({ open: "" }).code, 3);
  assert.equal(runTailnetCheck({ dns: "" }).code, 1);
  const exposed = runTailnetCheck({ open: "100.64.0.7 203.0.113.9" });
  assert.equal(exposed.code, 1);
  assert.match(exposed.out, /EXPOSED/);
});

// DEVOS-82: the installer refuses a Coolify token without write permission at install time, not at the first deploy.
const TOKEN_CHECK = path.join(ROOT, "scripts/server/coolify-token-check.sh");
const INSTALLER = path.join(ROOT, "scripts/server/install-server-agent.sh");
function runTokenCheck(extra = {}) {
  const envf = path.join(tmp, "cf-check.env");
  fs.writeFileSync(envf, `COOLIFY_TOKEN=${CF_TOKEN}\nCOOLIFY_APP_UUID=app-uuid-1234\n`, { mode: 0o600 });
  return new Promise((resolve) => {
    const ch = spawn("bash", [TOKEN_CHECK, envf], { env: { ...process.env, COOLIFY_API: `http://127.0.0.1:${port}/cf`, AGENT_LOCK: path.join(tmp, "lock/agent.lock"), ...extra } });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (out += d));
    ch.on("close", (code) => resolve({ code, out }));
  });
}

test("DEVOS-82 AT13: a read + deploy token is refused with \"missing write permission\"; nothing changes", async () => {
  resetMock(); M.cfPerms = "read deploy"; M.appSha = "0123456789abcdef0123456789abcdef01234567";
  const r = await runTokenCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /missing write permission/);
  assert.match(r.out, /read \+ write \+ deploy/);
  assert.equal(M.appSha, "0123456789abcdef0123456789abcdef01234567", "the app is unchanged");
  assert.ok(!reqs.some((q) => q.path === "/cf/deploy"), "no deployment started");
  assert.ok(!r.out.includes(CF_TOKEN), "the token is never printed");
  assert.ok(reqs.every((q) => q.auth === `Bearer ${CF_TOKEN}`), "the token reaches Coolify as a Bearer header");
});

test("DEVOS-82 AT13: a read-only token fails the read or write check; a token that cannot read fails with missing read permission", async () => {
  resetMock(); M.cfPerms = "read";
  let r = await runTokenCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /missing write permission/);
  resetMock(); M.cfPerms = "deploy";
  r = await runTokenCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /missing read permission/);
  assert.equal(writes().length, 0, "no write is attempted without read");
});

test("DEVOS-82 AT14: a read + write + deploy token passes with an idempotent no-op PATCH (same git_commit_sha)", async () => {
  resetMock(); M.appSha = "fedcba9876543210fedcba9876543210fedcba98";
  const r = await runTokenCheck();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /token can write/);
  assert.deepEqual(M.deployPatch, [{ git_commit_sha: "fedcba9876543210fedcba9876543210fedcba98" }], "only its current value is written back");
  assert.equal(M.appSha, "fedcba9876543210fedcba9876543210fedcba98");
  assert.ok(!reqs.some((q) => q.path === "/cf/deploy"), "no deployment started");
  assert.ok(!r.out.includes(CF_TOKEN));
});

test("DEVOS-82 AT15: the installer asks for read + write + deploy and checks a new token before storing it", () => {
  const src = fs.readFileSync(INSTALLER, "utf8");
  assert.match(src, /read \+ write \+ deploy/);
  assert.doesNotMatch(src, /permission: deploy \+ read/);
  assert.match(src, /install -m 700 "\$SRC\/coolify-token-check\.sh"/, "the check is installed next to the installer");
  const check = src.indexOf('bash "$CHECK" "$CF_ENV.new"'), store = src.indexOf('mv -f "$CF_ENV.new" "$CF_ENV"');
  assert.ok(check > 0 && store > check, "a new token is checked before it replaces the stored one");
  assert.match(src, /--deploy-on && -s "\$CF_ENV"[\s\S]*?coolify-token-check\.sh" "\$CF_ENV"/, "--deploy-on re-checks the stored token");
  execFileSync("bash", ["-n", INSTALLER]); execFileSync("bash", ["-n", TOKEN_CHECK]);
});

test("DEVOS-82 AT16 (Codex PR26-r1): the token check runs under the agent's lock; while a tick holds it, nothing is read or written", async () => {
  resetMock();
  const lock = path.join(tmp, "lock/agent.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const holder = spawn("flock", [lock, "sleep", "5"]);
  await new Promise((r) => setTimeout(r, 300));
  const busy = await runTokenCheck({ LOCK_WAIT: "1" });
  assert.equal(busy.code, 1, busy.out);
  assert.match(busy.out, /agent tick did not finish/);
  assert.equal(reqs.length, 0, "no Coolify call while the agent holds the lock");
  holder.kill(); await new Promise((r) => holder.on("close", r));
  const ok = await runTokenCheck({ LOCK_WAIT: "1" });
  assert.equal(ok.code, 0, ok.out);
});
