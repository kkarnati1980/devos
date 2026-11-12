// M2.5-a3 (docs/modules/M2.5.md, "M2.5-a3 build notes"): purge of what M2.4-c1 provisions — Coolify environments
// and inventory-only host ports — on fake providers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, stackSteps, parsePortRange, runProvision,
  githubRepoOps, coolifyProjectOps, coolifyEnvironmentOps, coolifyPortOps, githubScanner, coolifyScanner,
} from "@devos/provision";
import { archiveProject, purgeProject, inventoryScanner, MemoryTeardownStore, TeardownError } from "../dist/index.js";
import { fakeProviders } from "../../provision/test/fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const RANGE = parsePortRange("20000-20999");

/** M2.4's fakes plus the teardown endpoints this test needs: repo DELETE/PATCH, repo list, project and environment DELETE. */
function fakes() {
  const base = fakeProviders();
  const calls = [];
  const faults = []; // { match(method, path), status }
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    calls.push({ method, path });
    const f = faults.find((x) => !x.used && x.match(method, path));
    if (f) { f.used = true; return json(f.status, { message: "injected" }); }
    let m;
    if (u.origin === "https://api.github.com") {
      if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && (method === "PATCH" || method === "DELETE")) {
        const key = `${m[1]}/${m[2]}`.toLowerCase();
        const r = base.repos.get(key);
        if (!r) return json(404, { message: "Not Found" });
        if (method === "DELETE") { base.repos.delete(key); return new Response(null, { status: 204 }); }
        Object.assign(r, JSON.parse(init.body));
        return json(200, r);
      }
      if (method === "GET" && path === "/user/repos") return json(200, Number(u.searchParams.get("page") ?? 1) === 1 ? [...base.repos.values()] : []);
    }
    if (u.origin === "http://coolify.test:8000" && method === "DELETE") {
      if ((m = path.match(/^\/api\/v1\/projects\/([^/]+)\/environments\/([^/]+)$/))) {
        const p = base.projects.get(m[1]);
        if (!p || !p.environments.includes(m[2])) return json(404, { message: "Environment not found." });
        p.environments = p.environments.filter((e) => e !== m[2]);
        return json(200, { message: "Environment deleted." });
      }
      if ((m = path.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
        if (!base.projects.has(m[1])) return json(404, { message: "Project not found." });
        base.projects.delete(m[1]);
        return json(200, { message: "Project deleted." });
      }
    }
    return base.fetchImpl(url, init);
  }
  return { ...base, fetchImpl, calls, faults, deletes: () => calls.filter((c) => c.method === "DELETE") };
}

function setup() {
  const fake = fakes();
  const sleep = async () => {};
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const store = new MemoryTeardownStore();
  store.addProject({ id: P.id, slug: P.slug, stage: "live" });
  const steps = () => [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P), ...stackSteps(cf, store, P, RANGE)];
  const ops = [githubRepoOps(gh, P.id), coolifyProjectOps(cf, P.id), coolifyEnvironmentOps(cf, P.id), coolifyPortOps()];
  const scanners = [githubScanner(gh), coolifyScanner(cf), inventoryScanner(store)];
  const base = { store, ops, now: () => Date.UTC(2026, 10, 12, 13, 0, 0) };
  return { fake, cf, store, steps, scanners, base };
}

const provision = (s) => runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });
const coolifyProject = (s) => [...s.fake.projects.values()][0];

test("M2.5-a3 AT1: a project with environments and ports purges to 0; environments go before the project, the repo last", async () => {
  const s = setup();
  await provision(s);
  assert.deepEqual([...coolifyProject(s).environments].sort(), ["preview", "production"]);
  assert.equal(s.store.resources.filter((r) => r.kind === "port").length, 2);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  assert.equal(s.fake.deletes().length, 0, "archive deletes nothing");
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  assert.equal(out.deleted, 4, "repo, project and two environments; ports are inventory only");
  assert.equal(s.fake.projects.size, 0);
  assert.equal(s.fake.repos.size, 0);
  assert.ok(s.store.resources.every((r) => r.deletedAt), "every row, ports included, is marked deleted");
  const order = s.fake.deletes().map((c) => c.path);
  assert.equal(order.length, 4);
  assert.match(order[0], /\/environments\/(preview|production)$/);
  assert.match(order[1], /\/environments\/(preview|production)$/);
  assert.match(order[2], /^\/api\/v1\/projects\/[^/]+$/);
  assert.match(order[3], /^\/repos\//);
});

test("M2.5-a3: purged ports keep their rows, so a re-provision never reuses them", async () => {
  const s = setup();
  await provision(s);
  const before = s.store.resources.filter((r) => r.kind === "port").map((r) => r.externalId).sort();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  s.store.addProject({ id: P.id, slug: P.slug, stage: "live" });
  await provision(s);
  const active = s.store.resources.filter((r) => r.kind === "port" && !r.deletedAt).map((r) => r.externalId);
  assert.equal(active.length, 2);
  for (const p of active) assert.ok(!before.includes(p), `port ${p} was reused`);
});

test("M2.5-a3: an environment whose project lost the marker is not deleted (ownership_mismatch)", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  coolifyProject(s).description = "someone else's project now";
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }),
    (e) => e instanceof TeardownError && e.code === "ownership_mismatch" && e.retryable === false && e.resource.kind === "environment",
  );
  assert.ok(!s.fake.deletes().some((d) => d.path.includes("/environments/")), "no environment deleted");
  assert.equal(coolifyProject(s).environments.length, 2);
  assert.ok(s.store.resources.filter((r) => r.kind === "port").every((r) => !r.deletedAt), "a stopped purge keeps the port reservations");
});

test("M2.5-a3: an environment already gone, or under a project already gone, is marked deleted without a delete call", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  coolifyProject(s).environments = ["production"];
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, true);
  assert.equal(s.fake.deletes().filter((d) => d.path.includes("/environments/")).length, 1);

  const s2 = setup();
  await provision(s2);
  await archiveProject(P.id, { ...s2.base, authorize: allowAll });
  s2.fake.projects.clear();
  const out2 = await purgeProject(P.id, { ...s2.base, authorize: allowAll, scanners: s2.scanners });
  assert.equal(out2.purged, true);
  assert.ok(!s2.fake.deletes().some((d) => d.path.startsWith("/api/")), "nothing left at Coolify to delete");
});

test("M2.5-a3: an inconclusive environment lookup (a 200 that is not a list) stops the purge and leaves the row active", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.faults.push({ match: (m, p) => m === "GET" && /\/environments$/.test(p), status: 200 });
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e instanceof TeardownError && e.code === "provider_error");
  assert.equal(s.fake.deletes().length, 0);
  assert.ok(s.store.resources.filter((r) => r.kind === "environment" || r.kind === "port").every((r) => !r.deletedAt));
});

test("M2.5-a3 pre-review: a DELETE that answers 404 while the environment is still listed stops the purge", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.faults.push({ match: (m, p) => m === "DELETE" && /\/environments\//.test(p), status: 404 });
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e instanceof TeardownError && e.code === "provider_error" && e.resource.kind === "environment");
  assert.equal(coolifyProject(s).environments.length, 2);
  assert.ok(!s.fake.deletes().some((d) => /^\/api\/v1\/projects\/[^/]+$/.test(d.path)), "the project is not deleted");
  assert.ok(s.store.resources.every((r) => !r.deletedAt), "no row marked deleted");
});

test("M2.5-a3: malformed environment and port ids are refused before any call", async () => {
  const s = setup();
  const env = coolifyEnvironmentOps(s.cf, P.id);
  for (const externalId of ["abc", "abc/staging", "../x/preview", "a/b/preview"]) {
    await assert.rejects(env.inspect({ provider: "coolify", kind: "environment", externalId, name: "preview" }), /coolify-environment-id-invalid/);
  }
  await assert.rejects(env.remove({ provider: "coolify", kind: "environment", externalId: "abc/preview", name: "production" }), /coolify-environment-id-invalid/);
  const port = coolifyPortOps();
  for (const externalId of ["0", "80a", "99999", ""]) await assert.rejects(port.inspect({ provider: "coolify", kind: "port", externalId, name: "acme/preview" }), /coolify-port-invalid/);
  assert.equal(s.fake.calls.length, 0);
});
