// M2.4-a acceptance tests on fake providers (docs/modules/M2.4.md: AT1–AT5, AT8, AT9, AT12).
import test from "node:test";
import assert from "node:assert/strict";
import { allowAll, PrismaStore, GitHubClient, CoolifyClient, MemoryStore, githubRepoStep, coolifyProjectStep, runProvision, runStep, StepError, ProviderError, Transport } from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const OTHER = { id: "99999999-2222-4333-8444-555555555555", slug: "acme", name: "Other" };
const noSleep = async () => {};

function setup(fake = fakeProviders()) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const steps = (p = P) => [githubRepoStep(gh, p, "kkarnati1980"), coolifyProjectStep(cf, p)];
  return { fake, gh, cf, steps, store: new MemoryStore() };
}

test("AT1 fresh provision creates each resource once and records it with the project id", async () => {
  const { fake, steps, store } = setup();
  const out = await runProvision(P.id, steps(), { store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["created", "created"]);
  assert.equal(fake.repos.get("kkarnati1980/devos-acme").private, true);
  assert.match(fake.repos.get("kkarnati1980/devos-acme").description, /devos:11111111-2222-4333-8444-555555555555$/);
  assert.equal(store.resources.length, 2);
  assert.ok(store.resources.every((r) => r.projectId === P.id));
  assert.deepEqual(store.resources.map((r) => `${r.provider}/${r.kind}`), ["github/repo", "coolify/project"]);
  assert.ok([...store.steps.values()].every((s) => s.status === "done" && s.externalId));
});

test("AT2 a re-run creates nothing and adds no inventory rows", async () => {
  const { fake, steps, store } = setup();
  await runProvision(P.id, steps(), { store, authorize: allowAll });
  const before = fake.creates().length;
  const out = await runProvision(P.id, steps(), { store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["recorded", "recorded"]);
  assert.equal(fake.creates().length, before);
  assert.equal(store.resources.length, 2);
  // Even with a fresh journal (DB restored, rows lost) it adopts instead of creating.
  const fresh = new MemoryStore();
  const out2 = await runProvision(P.id, steps(), { store: fresh, authorize: allowAll });
  assert.deepEqual(out2.map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(fake.creates().length, before);
});

for (const [i, key] of ["github/repo", "coolify/project"].entries()) {
  test(`AT3 crash right after the ${key} create, before the DB write: the re-run adopts it`, async () => {
    const { fake, steps, store } = setup();
    // Simulate the crash: the store throws on the first markDone/recordResource for this step.
    const crashing = Object.create(store);
    let crashed = false;
    crashing.recordResource = async (pid, r) => {
      if (!crashed && `${r.provider}/${r.kind}` === key) { crashed = true; throw new Error("process killed"); }
      return store.recordResource(pid, r);
    };
    await assert.rejects(runProvision(P.id, steps(), { store: crashing, authorize: allowAll }), /process killed/);
    assert.equal(store.steps.get(`${P.id}/${key}`).status, "pending");
    const out = await runProvision(P.id, steps(), { store, authorize: allowAll });
    assert.equal(out[i].outcome, "adopted");
    const posts = fake.creates();
    assert.equal(posts.filter((c) => c.path === "/user/repos").length, 1);
    assert.equal(posts.filter((c) => c.path === "/api/v1/projects").length, 1);
    assert.equal(store.resources.length, 2);
  });
}

test("AT4 a create that succeeds but times out is looked up and adopted, never POSTed again", async () => {
  const { fake, steps, store } = setup();
  fake.faults.push({ match: (m, p) => m === "POST" && p === "/user/repos", action: "timeout-after" });
  const out = await runProvision(P.id, steps(), { store, authorize: allowAll });
  assert.equal(out[0].outcome, "adopted");
  assert.equal(fake.creates().filter((c) => c.path === "/user/repos").length, 1);
});

test("AT4b a create that fails with 5xx and did not happen ends create_unconfirmed (retryable); the next run creates once", async () => {
  const { fake, steps, store } = setup();
  fake.faults.push({ match: (m, p) => m === "POST" && p === "/user/repos", action: { status: 502 } });
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), (e) => e instanceof StepError && e.code === "create_unconfirmed" && e.retryable);
  assert.equal(store.steps.get(`${P.id}/github/repo`).status, "failed");
  const out = await runProvision(P.id, steps(), { store, authorize: allowAll });
  assert.equal(out[0].outcome, "created");
  assert.equal(fake.repos.size, 1);
});

test("AT5 a same-named repo without our marker is a non-retryable name_conflict and is not adopted", async () => {
  const { fake, steps, store } = setup();
  await runProvision(OTHER.id, [steps(OTHER)[0]], { store: new MemoryStore(), authorize: allowAll });
  const posts = fake.creates().length;
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), (e) => e instanceof StepError && e.code === "name_conflict" && !e.retryable);
  assert.equal(fake.creates().length, posts);
  assert.equal(store.resources.length, 0);
  assert.match(store.steps.get(`${P.id}/github/repo`).lastError, /^name_conflict/);
});

test("AT5b a public repo with our marker is not ours either (must be private)", async () => {
  const { fake, steps, store } = setup();
  fake.repos.set("kkarnati1980/devos-acme", { id: 1, name: "devos-acme", full_name: "kkarnati1980/devos-acme", private: false, description: `x devos:${P.id}` });
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), (e) => e.code === "name_conflict");
});

test("AT5c a resource already in another project's inventory is refused", async () => {
  const { steps, store } = setup();
  await runProvision(P.id, steps(), { store, authorize: allowAll });
  store.steps.clear();
  await assert.rejects(store.recordResource(OTHER.id, { ...store.resources[0] }), /resource_owned_elsewhere/);
});

test("AT8 two runs for the same project at once: one waits; each resource is created once", async () => {
  const { fake, steps, store } = setup();
  const [a, b] = await Promise.all([runProvision(P.id, steps(), { store, authorize: allowAll }), runProvision(P.id, steps(), { store, authorize: allowAll })]);
  assert.deepEqual(a.map((o) => o.outcome), ["created", "created"]);
  assert.deepEqual(b.map((o) => o.outcome), ["recorded", "recorded"]);
  assert.equal(fake.creates().filter((c) => c.path === "/user/repos").length, 1);
  assert.equal(fake.creates().filter((c) => c.path === "/api/v1/projects").length, 1);
});

test("AT9 reads retry on 503 with backoff; a 4xx read is not retried; a write is never retried by the transport", async () => {
  const fake = fakeProviders();
  const sleeps = [];
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  fake.faults.push({ match: (m, p) => m === "GET" && p.startsWith("/repos/"), action: { status: 503 } });
  assert.equal(await gh.findRepo("kkarnati1980", "devos-acme"), null);
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 2);
  assert.equal(sleeps.length, 1);
  fake.faults.push({ match: (m, p) => m === "GET" && p.startsWith("/repos/"), action: { status: 403 } });
  await assert.rejects(gh.findRepo("kkarnati1980", "devos-acme"), (e) => e instanceof ProviderError && e.status === 403);
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 3);
  fake.faults.push({ match: (m) => m === "POST", action: { status: 503 } });
  await assert.rejects(gh.createRepo("devos-acme", "x"), (e) => e.status === 503);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 1);
});

test("AT9b every call carries a timeout signal; a stuck call ends as a timeout error", async () => {
  let signal;
  const t = new Transport({ provider: "github", origin: "https://api.github.com", token: () => TOKEN, timeoutMs: 50, maxAttempts: 1,
    fetchImpl: (u, init) => { signal = init.signal; return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))); } });
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout's timer does not hold the event loop open
  await assert.rejects(t.get("/x"), (e) => e instanceof ProviderError && e.code === "timeout");
  clearTimeout(keepAlive);
  assert.ok(signal instanceof AbortSignal);
});

test("AT12 a deny rule stops the create step as policy_denied (not an attempt) and creates nothing", async () => {
  const { fake, steps, store } = setup();
  const seen = [];
  const authorize = async (action, resource) => { seen.push([action, resource]); return action === "provision.github.repo" ? "deny" : "allow"; };
  await assert.rejects(runProvision(P.id, steps(), { store, authorize }), (e) => e.code === "policy_denied" && e.countsAsAttempt === false && !e.retryable);
  assert.deepEqual(seen, [["provision.github.repo", `project:${P.id}`]]);
  assert.equal(fake.creates().length, 0);
  assert.equal(store.steps.get(`${P.id}/github/repo`).attempts, 0);
  // require_approval also stops, with its own code; an adopted resource needs no policy call.
  const store2 = new MemoryStore();
  await assert.rejects(runProvision(P.id, steps(), { store: store2, authorize: async () => "require_approval" }), (e) => e.code === "approval_required");
});

test("Secrets: the token is sent only in the auth header and never appears in errors or the journal (lookup and create failures)", async () => {
  for (const fault of [
    { match: (m, p) => m === "POST" && p === "/user/repos", action: { status: 500 } }, // create fails (unknown outcome)
    { match: (m, p) => m === "POST" && p === "/user/repos", action: { status: 400 } }, // create rejected
    { match: (m, p) => m === "GET" && p.startsWith("/repos/"), action: { status: 500 }, once: false }, // lookup fails
  ]) {
    const { fake, steps, store } = setup();
    fake.faults.push(fault);
    let err;
    try { await runProvision(P.id, steps(), { store, authorize: allowAll }); } catch (e) { err = e; }
    assert.ok(err, "the run must fail");
    if (fault.match("POST", "/user/repos")) assert.equal(fake.calls.filter((c) => c.method === "POST").length, 1);
    const blob = JSON.stringify({ msg: err.message, stack: err.stack, steps: [...store.steps.values()], res: store.resources });
    assert.ok(!blob.includes(TOKEN));
    assert.ok([...store.steps.values()].every((x) => x.lastError && x.lastError.length <= 300));
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${TOKEN}` && !JSON.stringify(c.body ?? "").includes(TOKEN)));
  }
});

test("A 422 with nothing under our name is a permanent provider_error, not retried", async () => {
  const { fake, steps, store } = setup();
  fake.faults.push({ match: (m, p) => m === "POST" && p === "/user/repos", action: { status: 422 } });
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), (e) => e.code === "provider_error" && !e.retryable);
});

test("Owner mismatch is caught before the create: no orphan repo on the token's account", async () => {
  const { fake, steps, store } = setup();
  fake.state.login = "someone-else";
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), (e) => e.code === "provider_error" && !e.retryable);
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(fake.repos.size, 0);
});

test("authorize is required (ADR-0006): a run without it fails before any create", async () => {
  const { fake, steps, store } = setup();
  await assert.rejects(runProvision(P.id, steps(), { store }), /authorize is required/);
  assert.equal(fake.creates().length, 0);
});

test("A lost project lock stops the run before the create", async () => {
  const { fake, steps, store } = setup();
  store.lockLost = true;
  await assert.rejects(runProvision(P.id, steps(), { store, authorize: allowAll }), /provision_lock_lost/);
  assert.equal(fake.creates().length, 0);
});

test("PrismaStore lock: session lock with lock_timeout, released at the end, and a dead lock connection stops creates", async () => {
  const log = []; let pingFails = false;
  const conn = { query: async (sql, params) => { log.push([sql, params]); if (sql === "SELECT 1" && pingFails) throw new Error("conn gone"); return {}; },
                 end: async () => { log.push(["end"]); }, on: () => {} };
  const store = new PrismaStore({ provisionStep: {}, resource: {} }, { connectLock: async () => conn, lockWaitMs: 5000 });
  await store.withProjectLock(P.id, async () => {
    await store.assertLockHeld(P.id);
    pingFails = true;
    await assert.rejects(store.assertLockHeld(P.id), /provision_lock_lost/);
  });
  assert.deepEqual(log.map((l) => l[0]), ["SET lock_timeout = 5000", "SELECT pg_advisory_lock(hashtext('devos:provision'), hashtext($1))", "SELECT 1", "SELECT 1",
    "SELECT pg_advisory_unlock(hashtext('devos:provision'), hashtext($1))", "end"]);
  assert.deepEqual(log[1][1], [P.id]);
  await assert.rejects(store.assertLockHeld(P.id), /provision_lock_lost/); // not held after the run
});

test("PrismaStore: two runs for one project on one store queue (no re-entry error); a lock timeout is typed provision_busy", async () => {
  const order = [];
  const conn = () => ({ query: async () => ({}), end: async () => {}, on: () => {} });
  const store = new PrismaStore({ provisionStep: {}, resource: {} }, { connectLock: async () => conn() });
  await Promise.all([1, 2].map((i) => store.withProjectLock(P.id, async () => { order.push(`start${i}`); await new Promise((r) => setTimeout(r, 20)); order.push(`end${i}`); })));
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
  const busy = new PrismaStore({ provisionStep: {}, resource: {} }, { connectLock: async () => ({ query: async (sql) => { if (sql.includes("pg_advisory_lock(")) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }); return {}; }, end: async () => {}, on: () => {} }) });
  await assert.rejects(busy.withProjectLock(P.id, async () => "x"), /provision_busy/);
});

test("Transport refuses an origin with a path and a path that escapes the origin", async () => {
  assert.throws(() => new Transport({ provider: "x", origin: "https://api.github.com/evil", token: () => "t" }), /transport-origin-invalid/);
  const t = new Transport({ provider: "x", origin: "https://api.github.com", token: () => "t", fetchImpl: async () => new Response("{}") });
  await assert.rejects(t.get("//evil.example/x"), /transport-path-invalid/);
  await assert.rejects(t.get("https://evil.example/x"), /transport-path-invalid/);
});

test("runStep on a done step makes no provider calls", async () => {
  const { fake, steps, store } = setup();
  await runStep(P.id, steps()[0], { store, authorize: allowAll });
  const n = fake.calls.length;
  const r = await runStep(P.id, steps()[0], { store, authorize: allowAll });
  assert.equal(r.outcome, "recorded");
  assert.equal(fake.calls.length, n);
});
