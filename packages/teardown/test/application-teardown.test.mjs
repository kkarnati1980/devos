// M2.5-a3b (DEVOS-133, docs/modules/M2.5.md "M2.5-a3b decisions"): Archive and Purge of a project with Coolify
// applications, on M2.4's fake providers. The project, environments and ports come from M2.4-c1's real steps; the
// two applications are seeded as M2.4-c2 records them (one inventory row per environment, marker in the description).
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, stackSteps, parsePortRange, runProvision,
  githubRepoOps, coolifyProjectOps, coolifyEnvironmentOps, coolifyPortOps, coolifyApplicationOps, githubScanner, coolifyScanner,
  ownershipMarker, applicationName,
} from "@devos/provision";
import { archiveProject, restoreProject, purgeProject, inventoryScanner, MemoryTeardownStore, TeardownError } from "../dist/index.js";
import { fakeProviders } from "../../provision/test/fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const RANGE = parsePortRange("20000-20999");
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakes() {
  const base = fakeProviders();
  const calls = [];
  const lingering = new Map(); // uuid -> reads left before a queued delete finishes (Coolify queues it)
  const stopStatus = { value: 200 };
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    calls.push({ method, path, query: u.search });
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
    if (u.origin === "http://coolify.test:8000") {
      if ((m = path.match(/^\/api\/v1\/applications\/([^/]+)\/stop$/)) && method === "GET") {
        const a = base.apps.get(m[1]);
        if (!a) return json(404, { message: "Application not found." });
        if (stopStatus.value !== 200) return json(stopStatus.value, { message: "injected" });
        a.stopped = true;
        return json(200, { message: "Stopping request queued." });
      }
      if ((m = path.match(/^\/api\/v1\/applications\/([^/]+)$/))) {
        const a = base.apps.get(m[1]);
        if (!a) return json(404, { message: "Application not found." });
        if (method === "GET") {
          if (a.deleting) {
            const left = (lingering.get(a.uuid) ?? 0) - 1;
            lingering.set(a.uuid, left);
            if (left < 0) { base.apps.delete(a.uuid); return json(404, { message: "Application not found." }); }
          }
          return json(200, { uuid: a.uuid, name: a.name, description: a.description });
        }
        if (method === "DELETE") {
          if (lingering.has(a.uuid)) { a.deleting = true; return json(200, { message: "Application deletion request queued." }); }
          base.apps.delete(m[1]);
          return json(200, { message: "Application deletion request queued." });
        }
      }
      if (method === "DELETE" && (m = path.match(/^\/api\/v1\/projects\/([^/]+)\/environments\/([^/]+)$/))) {
        const p = base.projects.get(m[1]);
        if (!p || !p.environments.includes(m[2])) return json(404, { message: "Environment not found." });
        // Like Coolify: an environment that still holds an application cannot be deleted.
        if ([...base.apps.values()].some((a) => a.environment === m[2])) return json(400, { message: "Environment has resources." });
        p.environments = p.environments.filter((e) => e !== m[2]);
        return json(200, { message: "Environment deleted." });
      }
      if (method === "DELETE" && (m = path.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
        if (!base.projects.has(m[1])) return json(404, { message: "Project not found." });
        base.projects.delete(m[1]);
        return json(200, { message: "Project deleted." });
      }
    }
    return base.fetchImpl(url, init);
  }
  return { ...base, fetchImpl, calls, lingering, stopStatus, deletes: () => calls.filter((c) => c.method === "DELETE") };
}

async function setup(appOpts = { sleep: async () => {} }) {
  const fake = fakes();
  const sleep = async () => {};
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const store = new MemoryTeardownStore();
  store.addProject({ id: P.id, slug: P.slug, stage: "live" });
  await runProvision(P.id, [githubRepoStep(gh, P, "kkarnati1980"), coolifyProjectStep(cf, P), ...stackSteps(cf, store, P, RANGE)], { store, authorize: allowAll });
  // The two applications as M2.4-c2 records them, created after the environments.
  for (const [env, uuid] of [["preview", "app-preview-1"], ["production", "app-live-1"]]) {
    const name = applicationName(P.slug, env);
    fake.apps.set(uuid, { uuid, name, description: `DevOS app ${ownershipMarker(P.id)}`, environment: env });
    await store.recordResource(P.id, { provider: "coolify", kind: "application", externalId: uuid, name });
  }
  const ops = [githubRepoOps(gh, P.id), coolifyProjectOps(cf, P.id), coolifyEnvironmentOps(cf, P.id), coolifyPortOps(), coolifyApplicationOps(cf, P.id, appOpts)];
  const scanners = [githubScanner(gh), coolifyScanner(cf), inventoryScanner(store), store.vaultScanner()];
  const base = { store, ops, now: () => Date.UTC(2026, 10, 16, 0, 0, 0) };
  return { fake, store, scanners, base };
}

test("M2.5-a3b: Archive stops both applications and deletes nothing", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  assert.ok([...s.fake.apps.values()].every((a) => a.stopped), "preview and live are stopped");
  assert.equal(s.fake.deletes().length, 0);
});

test("M2.5-a3b: Purge deletes applications (with volumes) before environments, the repo last, and reaches 0", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  assert.equal(s.fake.apps.size, 0);
  assert.equal(s.fake.projects.size, 0);
  const order = s.fake.deletes();
  const firstEnv = order.findIndex((c) => c.path.includes("/environments/"));
  const appDeletes = order.map((c, i) => [c, i]).filter(([c]) => c.path.startsWith("/api/v1/applications/"));
  assert.equal(appDeletes.length, 2);
  assert.ok(appDeletes.every(([, i]) => i < firstEnv), "both applications go before any environment");
  assert.ok(appDeletes.every(([c]) => c.query.includes("delete_volumes=true")), "volumes go with the application");
  assert.match(order.at(-1).path, /^\/repos\//);
});

test("M2.5-a3b: an application that lost the marker is not deleted (ownership_mismatch), nothing after it is", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.apps.get("app-live-1").description = "someone else's app";
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }),
    (e) => e instanceof TeardownError && e.code === "ownership_mismatch" && e.resource.kind === "application",
  );
  assert.ok(s.fake.apps.has("app-live-1"));
  assert.ok(!s.fake.deletes().some((d) => d.path.includes("/environments/")), "no environment deleted");
});

test("M2.5-a3b: an application left at Coolify but missing from the inventory is a leftover hit, so the project is not purged", async () => {
  const s = await setup();
  s.fake.apps.set("app-stray-1", { uuid: "app-stray-1", name: "renamed-by-hand", description: `x ${ownershipMarker(P.id)}`, environment: "none" });
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, false);
  assert.ok(out.report.hits.some((h) => h.kind === "application" && h.externalId === "app-stray-1"));
});

test("pre-review 1: a queued delete is confirmed by reading until it is gone; one not gone in time stops the purge, retryable", async () => {
  const s = await setup();
  for (const u of ["app-preview-1", "app-live-1"]) s.fake.lingering.set(u, 2);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, true, JSON.stringify(out.report));

  let t = 0;
  const u = await setup({ sleep: async (ms) => { t += ms; }, now: () => t, confirmMs: 10000, pollMs: 2000 });
  u.fake.lingering.set("app-preview-1", 1000);
  u.fake.lingering.set("app-live-1", 1000);
  await archiveProject(P.id, { ...u.base, authorize: allowAll });
  await assert.rejects(
    purgeProject(P.id, { ...u.base, authorize: allowAll, scanners: u.scanners }),
    (e) => e instanceof TeardownError && e.code === "delete_unconfirmed" && e.retryable === true && e.resource.kind === "application",
  );
  assert.ok(!u.fake.deletes().some((d) => d.path.includes("/environments/")), "no environment is touched");
  assert.equal(u.fake.deletes().filter((d) => d.path.startsWith("/api/v1/applications/")).length, 1, "one delete, then stop");
  assert.ok(u.store.resources.filter((r) => r.kind === "application").every((r) => !r.deletedAt), "rows stay active");
});

test("pre-review 2: Archive stops the stacks before the repo turns read-only; a failed stop leaves the repo writable", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const writes = s.fake.calls.filter((c) => c.path.endsWith("/stop") || (c.method === "PATCH" && c.path.startsWith("/repos/")));
  assert.match(writes.at(-1).path, /^\/repos\//, "the repo is archived last");

  const f = await setup();
  f.fake.stopStatus.value = 500;
  await assert.rejects(archiveProject(P.id, { ...f.base, authorize: allowAll }), TeardownError);
  assert.ok(!f.fake.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/repos/")), "the repo was not archived");
  assert.equal(f.store.projects.get(P.id).stage, "live");
});

test("pre-review 6: Restore makes no application call; the apps stay stopped and the stage moves back", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const before = s.fake.calls.length;
  await restoreProject(P.id, { ...s.base, authorize: allowAll });
  assert.ok(!s.fake.calls.slice(before).some((c) => c.path.startsWith("/api/v1/applications/")));
  assert.ok([...s.fake.apps.values()].every((a) => a.stopped));
  assert.equal(s.store.projects.get(P.id).stage, "live");
});
