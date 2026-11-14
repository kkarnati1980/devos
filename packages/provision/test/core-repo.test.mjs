// M2.4-b acceptance tests on fake GitHub (docs/modules/M2.4.md: AT6 core half, AT2/AT3/AT4/AT5 for `github/core`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowAll, GitHubClient, MemoryStore, githubRepoStep, githubCoreStep, coreTemplateFiles, readRepoFiles, assertRepoPath, blobSha, runProvision, StepError } from "../dist/index.js";
import { apply } from "../../../scripts/template/apply.mjs";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const FULL = "kkarnati1980/devos-acme";
const noSleep = async () => {};
const FILES = coreTemplateFiles(apply, { devosSha: "0".repeat(40) });

function setup(fake = fakeProviders(), store = new MemoryStore()) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const steps = (files = FILES) => [githubRepoStep(gh, P, "kkarnati1980"), githubCoreStep(gh, P, "kkarnati1980", files, "0.1.0", () => store.assertLockHeld(P.id))];
  return { fake, store, steps, run: (files) => runProvision(P.id, steps(files), { store, authorize: allowAll }) };
}

const mainTree = (fake) => {
  const g = fake.gitOf(FULL);
  const c = g.commits.get(g.main);
  return { commit: c, entries: g.trees.get(c.tree), blobs: g.blobs };
};

test("AT6 core only: main's tree is byte-equal to apply --out with no selection, and template.json selects nothing", async () => {
  const s = setup();
  const out = await s.run();
  assert.deepEqual(out.map((o) => o.outcome), ["created", "created"]);
  const ref = fs.mkdtempSync(path.join(os.tmpdir(), "at6-"));
  try {
    assert.equal(apply({ out: path.join(ref, "r"), select: [], sha: "0".repeat(40) }).code, 0);
    const want = readRepoFiles(path.join(ref, "r"));
    const { entries, blobs } = mainTree(s.fake);
    assert.deepEqual(entries.map((e) => `${e.path} ${e.mode}`).sort(), want.map((f) => `${f.path} ${f.mode}`).sort());
    for (const f of want) {
      const e = entries.find((x) => x.path === f.path);
      assert.ok(Buffer.compare(blobs.get(e.sha), f.content) === 0, `byte-equal: ${f.path}`);
    }
    const manifest = JSON.parse(blobs.get(entries.find((e) => e.path === ".devos/template.json").sha).toString());
    assert.deepEqual([manifest.selected, manifest.applied], [[], []]);
  } finally {
    fs.rmSync(ref, { recursive: true, force: true });
  }
  assert.equal(out[1].externalId, s.fake.gitOf(FULL).main);
  // Not an inventory row: the commit goes away with the repo (M2.5 purge must never meet an unknown kind).
  assert.deepEqual(s.store.resources.map((r) => r.kind), ["repo"]);
});

test("empty repo: one bootstrap commit (template.json only) then the core fast-forwarded on top, never forced", async () => {
  const s = setup();
  await s.run();
  const g = s.fake.gitOf(FULL);
  const head = g.commits.get(g.main);
  assert.equal(head.parents.length, 1);
  const boot = g.commits.get(head.parents[0]);
  assert.deepEqual(boot.parents, []);
  assert.deepEqual(g.trees.get(boot.tree).map((e) => e.path), [".devos/template.json"]);
  const patches = s.fake.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.force, false);
});

test("a repo that accepts Git Data while empty gets exactly one root commit with the whole core", async () => {
  const fake = fakeProviders();
  fake.state.gitEmpty409 = false;
  const s = setup(fake);
  await s.run();
  const { commit } = mainTree(fake);
  assert.deepEqual(commit.parents, []);
  assert.equal(fake.calls.filter((c) => c.method === "PUT").length, 0);
});

test("AT2 re-run creates nothing; a lost journal adopts main by tree comparison", async () => {
  const s = setup();
  await s.run();
  const before = s.fake.creates().length;
  const again = await s.run();
  assert.deepEqual(again.map((o) => o.outcome), ["recorded", "recorded"]);
  const fresh = new MemoryStore();
  fresh.resources.push(...s.store.resources);
  const s2 = setup(s.fake, fresh);
  const out = await s2.run();
  assert.deepEqual(out.map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(s.fake.creates().length, before);
});

test("AT3/AT4 the ref write times out after it happened: the step looks up and adopts, no second commit", async () => {
  const s = setup();
  s.fake.faults.push({ match: (m, p) => m === "PATCH" && p.endsWith("/git/refs/heads/main"), action: "timeout-after" });
  const out = await s.run();
  assert.equal(out[1].outcome, "adopted");
  assert.equal(s.fake.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(out[1].externalId, s.fake.gitOf(FULL).main);
});

test("AT3 a crash right after the bootstrap commit: the re-run finishes on top of it (fast-forward)", async () => {
  const s = setup();
  s.fake.faults.push({ match: (m, p) => m === "PUT" && p.includes("/contents/"), action: "timeout-after" });
  await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "create_unconfirmed" && e.retryable);
  const out = await s.run();
  assert.equal(out[1].outcome, "created");
  assert.equal(s.fake.calls.filter((c) => c.method === "PUT").length, 1);
  const g = s.fake.gitOf(FULL);
  assert.equal(g.commits.get(g.main).parents.length, 1);
  assert.equal(g.trees.get(g.commits.get(g.main).tree).length, FILES.length);
});

test("AT5 main with other content is never adopted or overwritten: name_conflict, non-retryable, no Git Data write", async () => {
  const fake = fakeProviders();
  const s = setup(fake);
  await runProvision(P.id, s.steps().slice(0, 1), { store: s.store, authorize: allowAll });
  const g = fake.gitOf(FULL);
  // Someone else's first commit on main.
  const content = Buffer.from("hello\n");
  const blob = blobSha(content);
  g.blobs.set(blob, content);
  g.trees.set("a".repeat(40), [{ path: "README.md", mode: "100644", type: "blob", sha: blob }]);
  g.commits.set("b".repeat(40), { tree: "a".repeat(40), parents: [] });
  g.main = "b".repeat(40);
  const writes = fake.creates().length;
  await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "name_conflict" && !e.retryable);
  assert.equal(fake.creates().length, writes);
  assert.equal(g.main, "b".repeat(40));
  assert.match((await s.store.getStep(P.id, "github/core")).lastError, /^name_conflict/);
});

test("a blob id that differs from the content hash (valid sha, wrong value) stops the push before any ref moves", async () => {
  const fake = fakeProviders();
  fake.state.gitEmpty409 = false;
  const s = setup(fake);
  const real = fake.fetchImpl;
  let first = true;
  fake.fetchImpl = async (url, init = {}) => {
    const r = await real(url, init);
    if (first && init.method === "POST" && String(url).endsWith("/git/blobs")) { first = false; return new Response(JSON.stringify({ sha: "c".repeat(40) }), { status: 201 }); }
    return r;
  };
  const s2 = setup(fake, s.store);
  await assert.rejects(s2.run(), (e) => e instanceof StepError && e.code === "provider_error");
  assert.equal(fake.calls.filter((c) => c.path.includes("/git/refs") && c.method !== "GET").length, 0);
  assert.equal(fake.gitOf(FULL).main, null);
});

test("pre-review r1: a redeploy (new devosSha) between runs still recognises DevOS's own bootstrap and core commits", async () => {
  const s = setup();
  s.fake.faults.push({ match: (m, p) => m === "PUT" && p.includes("/contents/"), action: "timeout-after" });
  await assert.rejects(s.run(), (e) => e.code === "create_unconfirmed");
  const NEW = coreTemplateFiles(apply, { devosSha: "1".repeat(40) });
  assert.notEqual(NEW.find((f) => f.path === ".devos/template.json").sha, FILES.find((f) => f.path === ".devos/template.json").sha);
  const out = await s.run(NEW);
  assert.equal(out[1].outcome, "created");
  // A lost journal after another redeploy adopts the core pushed under the previous sha.
  const fresh = new MemoryStore();
  fresh.resources.push(...s.store.resources);
  const writes = s.fake.creates().length;
  const out2 = await setup(s.fake, fresh).run(FILES);
  assert.deepEqual(out2.map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(s.fake.creates().length, writes);
});

test("pre-review r1: losing the lock before the ref write moves no ref", async () => {
  const s = setup();
  let n = 0;
  const orig = s.store.assertLockHeld.bind(s.store);
  s.store.assertLockHeld = async (id) => { if (++n > 5) throw new Error("provision_lock_lost"); return orig(id); }; // 2 checks per runner step, then the bootstrap check
  await assert.rejects(s.run(), (e) => e instanceof StepError && e.step === "github/core"); // as in c1: the lost lock stops the step
  assert.equal(s.fake.calls.filter((c) => c.method === "PUT").length, 1);
  assert.equal(s.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/commits")).length, 1);
  assert.equal(s.fake.calls.filter((c) => c.path.includes("/git/refs") && c.method !== "GET").length, 0);
});

test("a 201 with no blob id stops the push before any ref moves", async () => {
  const fake = fakeProviders();
  fake.state.gitEmpty409 = false;
  const s = setup(fake);
  fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/git/blobs"), action: { status: 201 }, once: true });
  // The injected 201 body has no sha → bad-response, a permanent provider_error, nothing written to refs.
  await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "provider_error");
  assert.equal(fake.calls.filter((c) => c.path.includes("/git/refs")).filter((c) => c.method !== "GET").length, 0);
});

test("policy deny on provision.github.core creates nothing in the repo", async () => {
  const s = setup();
  const authorize = async (action) => (action === "provision.github.core" ? "deny" : "allow");
  await assert.rejects(runProvision(P.id, s.steps(), { store: s.store, authorize }), (e) => e.code === "policy_denied" && !e.countsAsAttempt);
  assert.equal(s.fake.calls.filter((c) => c.path.includes("/git/") || c.path.includes("/contents/")).filter((c) => c.method !== "GET").length, 0);
});

test("template files: core-only check, path guard, symlinks refused", () => {
  assert.throws(() => coreTemplateFiles(({ out }) => {
    fs.mkdirSync(path.join(out, ".devos"), { recursive: true });
    fs.writeFileSync(path.join(out, ".devos/template.json"), JSON.stringify({ selected: ["SM-01"], applied: [] }));
    return { code: 0 };
  }, { devosSha: "x" }), /template-not-core-only/);
  assert.throws(() => coreTemplateFiles(() => ({ code: 2, error: "nope" }), { devosSha: "x" }), /template-apply-failed/);
  for (const bad of [".git/config", "../x", "a//b", "a/./b", "x y", ""]) assert.throws(() => assertRepoPath(bad), /repo-path-invalid/, bad);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
  try {
    fs.writeFileSync(path.join(d, "a.txt"), "a");
    fs.symlinkSync("/etc/passwd", path.join(d, "link"));
    assert.throws(() => readRepoFiles(d), /repo-file-unsupported: link/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  assert.equal(blobSha(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // git's empty blob
  assert.ok(FILES.length > 5 && FILES.some((f) => f.path === ".devos/template.json"));
});

test("pre-review r2: the root-commit path: a ref create that times out after it happened is adopted with one POST", async () => {
  const fake = fakeProviders();
  fake.state.gitEmpty409 = false;
  const s = setup(fake);
  fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/git/refs"), action: "timeout-after" });
  const out = await s.run();
  assert.equal(out[1].outcome, "adopted");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/refs")).length, 1);
});

test("pre-review r2: a 409 'empty' on a Git Data write after the bootstrap is retryable, and the re-run finishes", async () => {
  const s = setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/git/trees"), action: { status: 409 } });
  await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "create_unconfirmed" && e.retryable);
  const out = await s.run();
  assert.equal(out[1].outcome, "created");
  assert.equal(s.fake.calls.filter((c) => c.method === "PUT").length, 1);
});

test("c2c2: a lost journal still adopts the core when DevOS's deploy Compose files sit on top; any other extra file is a conflict", async () => {
  for (const [path, adopt] of [["deploy/compose.preview.devos.yaml", true], ["deploy/compose.staging.devos.yaml", false], ["deploy/other.yaml", false]]) {
    const s = setup();
    await s.run();
    const g = s.fake.gitOf(FULL);
    const content = Buffer.from("services: {}\n");
    g.blobs.set(blobSha(content), content);
    const tree = [...g.trees.get(g.commits.get(g.main).tree), { path, mode: "100644", type: "blob", sha: blobSha(content) }];
    g.trees.set("c".repeat(40), tree);
    g.commits.set("d".repeat(40), { tree: "c".repeat(40), parents: [g.main] });
    g.main = "d".repeat(40);
    const fresh = new MemoryStore();
    fresh.resources.push(...s.store.resources);
    const s2 = setup(s.fake, fresh);
    if (adopt) {
      const out = await s2.run();
      assert.deepEqual(out.map((o) => o.outcome), ["adopted", "adopted"], path);
    } else {
      await assert.rejects(s2.run(), (e) => e instanceof StepError && e.code === "name_conflict", path);
    }
  }
});
