// M2.4-c1 acceptance tests on fake Coolify (docs/modules/M2.4.md: AT10, and AT1–AT4 for the new steps).
import test from "node:test";
import assert from "node:assert/strict";
import { allowAll, CoolifyClient, GitHubClient, MemoryStore, coolifyProjectStep, githubRepoStep, stackSteps, portStep, parsePortRange, runProvision, StepError } from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const Q = { id: "22222222-2222-4333-8444-555555555555", slug: "beta", name: "Beta" };
const noSleep = async () => {};
const RANGE = parsePortRange("20000-20999");

function setup(fake = fakeProviders(), store = new MemoryStore()) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const steps = (p = P, range = RANGE) => [githubRepoStep(gh, p, "kkarnati1980"), coolifyProjectStep(cf, p), ...stackSteps(cf, store, p, range)];
  return { fake, cf, store, steps };
}

test("AT1/AT2 environments and ports are created once, recorded, and a re-run creates nothing", async () => {
  const s = setup();
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  // Coolify creates `production` with the project, so that step adopts it.
  assert.deepEqual(out.map((o) => o.outcome), ["created", "created", "created", "adopted", "created", "created"]);
  const proj = [...s.fake.projects.values()][0];
  assert.deepEqual([...proj.environments].sort(), ["preview", "production"]);
  const kinds = s.store.resources.map((r) => `${r.kind}:${r.externalId}`);
  assert.ok(kinds.includes(`environment:${proj.uuid}/preview`) && kinds.includes(`environment:${proj.uuid}/production`));
  assert.ok(kinds.includes("port:20000") && kinds.includes("port:20001"), kinds.join(","));
  const before = s.fake.creates().length;
  const again = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.ok(again.every((o) => o.outcome === "recorded"));
  assert.equal(s.fake.creates().length, before);
  // A fresh journal (rows lost) adopts the environments and keeps the same ports.
  const fresh = new MemoryStore();
  fresh.resources.push(...s.store.resources);
  const s2 = setup(s.fake, fresh);
  const out2 = await runProvision(P.id, s2.steps(), { store: fresh, authorize: allowAll });
  assert.deepEqual(out2.map((o) => o.outcome), ["adopted", "adopted", "adopted", "adopted", "adopted", "adopted"]);
  assert.deepEqual(out2.slice(4).map((o) => o.externalId), ["20000", "20001"]);
  assert.equal(s.fake.creates().length, before);
});

test("AT4 an environment create that times out after succeeding is adopted, never POSTed twice", async () => {
  const s = setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/environments"), action: "timeout-after" });
  const out = await runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
  assert.equal(out[2].outcome, "adopted");
  assert.equal(s.fake.creates().filter((c) => c.path.endsWith("/environments")).length, 1, "one POST (preview); production came with the project");
});

test("AT10 two projects get distinct, stable ports; preview even, production odd; an exhausted range fails cleanly", async () => {
  const s = setup();
  await runProvision(P.id, s.steps(P), { store: s.store, authorize: allowAll });
  await runProvision(Q.id, s.steps(Q), { store: s.store, authorize: allowAll });
  const port = (pid, env) => s.store.resources.find((r) => r.projectId === pid && r.kind === "port" && r.name.endsWith(`/${env}`)).externalId;
  assert.deepEqual([port(P.id, "preview"), port(P.id, "production"), port(Q.id, "preview"), port(Q.id, "production")], ["20000", "20001", "20002", "20003"]);
  await runProvision(Q.id, s.steps(Q), { store: s.store, authorize: allowAll });
  assert.equal(port(Q.id, "preview"), "20002", "a re-run keeps the port");
  // A range with room for one project only.
  const R = { id: "33333333-2222-4333-8444-555555555555", slug: "gamma", name: "Gamma" };
  const small = parsePortRange("20000-20003");
  await assert.rejects(runProvision(R.id, s.steps(R, small), { store: s.store, authorize: allowAll }),
    (e) => e instanceof StepError && e.code === "port_range_exhausted" && e.retryable === false);
  assert.match(s.store.steps.get(`${R.id}/coolify/port/preview`).lastError, /^port_range_exhausted/);
  assert.ok(!s.store.resources.some((r) => r.projectId === R.id && r.kind === "port"));
});

test("AT10 a port taken concurrently by another project is skipped, not shared", async () => {
  const store = new MemoryStore();
  const step = portStep(store, P, "preview", RANGE);
  // Another project inserts 20000 between our read and our insert.
  const orig = store.listResources.bind(store);
  let first = true;
  store.listResources = async (...a) => {
    const r = await orig(...a);
    if (first) { first = false; await store.recordResource(Q.id, { provider: "coolify", kind: "port", externalId: "20000", name: "beta/preview" }); }
    return r;
  };
  const got = await step.create();
  assert.equal(got.externalId, "20002");
});

test("port range parsing refuses bad values", () => {
  assert.deepEqual(parsePortRange(undefined), { from: 20000, to: 20999 });
  for (const bad of ["20999-20000", "80-90", "20000-70000", "a-b", "20000"]) assert.throws(() => parsePortRange(bad), /port-range-invalid/, bad);
});

test("an environment step without a provisioned Coolify project creates nothing", async () => {
  const s = setup();
  const [envStep] = stackSteps(s.cf, s.store, P, RANGE);
  await assert.rejects(runProvision(P.id, [envStep], { store: s.store, authorize: allowAll }));
  assert.equal(s.fake.creates().length, 0);
});

test("Codex PR50-r1: a lock lost during the port or environment read stops the write; an existing own port is adopted", async () => {
  const s = setup();
  await runProvision(P.id, s.steps().slice(0, 2), { store: s.store, authorize: allowAll });
  // The lock drops while the port list is read: nothing is inserted.
  const [, , envPreview, , portPreview] = s.steps();
  const orig = s.store.listResources.bind(s.store);
  s.store.listResources = async (...a) => { const r = await orig(...a); s.store.lockLost = true; return r; };
  await assert.rejects(portPreview.create(), /provision_lock_lost/);
  assert.ok(!s.store.resources.some((r) => r.kind === "port"));
  s.store.listResources = orig;
  // The lock drops while the parent uuid is read: no POST.
  const origGet = s.store.getStep.bind(s.store);
  s.store.lockLost = false;
  s.store.getStep = async (...a) => { const r = await origGet(...a); s.store.lockLost = true; return r; };
  const before = s.fake.creates().length;
  await assert.rejects(envPreview.create(), /provision_lock_lost/);
  assert.equal(s.fake.creates().length, before);
  s.store.getStep = origGet; s.store.lockLost = false;
  // A row another run of this project already inserted is adopted, not doubled.
  await s.store.recordResource(P.id, { provider: "coolify", kind: "port", externalId: "20000", name: "acme/preview" });
  assert.equal((await portPreview.create()).externalId, "20000");
  assert.equal(s.store.resources.filter((r) => r.kind === "port").length, 1);
});
