// M2.5-a3b (DEVOS-133, docs/modules/M2.5.md "M2.5-a3b decisions"): Archive and Purge of a project with Coolify
// applications, on M2.4's fake providers. The project, environments and ports come from M2.4-c1's real steps; the
// two applications are seeded as M2.4-c2 records them (one inventory row per environment, marker in the description).
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, stackSteps, parsePortRange, runProvision,
  githubRepoOps, coolifyProjectOps, coolifyEnvironmentOps, coolifyPortOps, coolifyApplicationOps, githubScanner, coolifyScanner,
  ownershipMarker, applicationName, coolifyTokenScopeCheck, pinnedCoolify,
} from "@devos/provision";
import { archiveProject, restoreProject, purgeProject, inventoryScanner, MemoryTeardownStore, TeardownError } from "../dist/index.js";
import { fakeProviders } from "../../provision/test/fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const OTHER_TEAM = "TESTONLY_coolify_token_of_another_team_0000";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const RANGE = parsePortRange("20000-20999");
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakes() {
  const base = fakeProviders();
  const calls = [];
  const lingering = new Map(); // uuid -> reads left before a queued delete finishes (Coolify queues it)
  const stopStatus = { value: 200 };
  const coolify = { wrongTeam: false, projectStatus: 0 }; // DEVOS-235: a token for another team sees no uuid
  const stopReads = new Map(); // uuid -> reads that still show "running:healthy" after a stop was queued
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    const auth = new Headers(init.headers ?? {}).get("authorization");
    calls.push({ method, path, query: u.search, auth });
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
      const wrongTeam = coolify.wrongTeam || auth === `Bearer ${OTHER_TEAM}`;
      if (wrongTeam && /^\/api\/v1\/(projects|applications)\/[^/]+/.test(path)) return json(404, { message: "Not found." });
      if (wrongTeam && method === "GET" && /^\/api\/v1\/(projects|applications)$/.test(path)) return json(200, []);
      if (coolify.projectStatus && method === "GET" && /^\/api\/v1\/projects\/[^/]+$/.test(path)) return json(coolify.projectStatus, { message: "injected" });
      if ((m = path.match(/^\/api\/v1\/applications\/([^/]+)\/stop$/)) && method === "GET") {
        const a = base.apps.get(m[1]);
        if (!a) return json(404, { message: "Application not found." });
        if (stopStatus.value !== 200) return json(stopStatus.value, { message: "injected" });
        // Like Coolify, the stop is queued: the app reads as running for `stopReads` more reads (default 1).
        a.stopping = stopReads.get(a.uuid) ?? 1;
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
          if (a.stopping !== undefined && !a.stopped) { if (a.stopping-- <= 0) a.stopped = true; }
          return json(200, { uuid: a.uuid, name: a.name, description: a.description, status: a.stopped ? "exited:unhealthy" : "running:healthy" });
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
  return { ...base, fetchImpl, calls, lingering, stopStatus, coolify, stopReads, deletes: () => calls.filter((c) => c.method === "DELETE") };
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
  return { fake, store, scanners, base, cf };
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

test("Codex PR154-r3: Archive waits until a queued stop shows the app stopped; still running in time fails, repo writable", async () => {
  const s = await setup();
  s.fake.stopReads.set("app-preview-1", 3);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  assert.ok([...s.fake.apps.values()].every((a) => a.stopped));
  const reads = s.fake.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/applications/app-preview-1");
  assert.ok(reads.length >= 4, "read until it showed exited");
  const repoPatch = s.fake.calls.findIndex((c) => c.method === "PATCH" && c.path.startsWith("/repos/"));
  const lastRead = s.fake.calls.findLastIndex((c) => c.method === "GET" && c.path.startsWith("/api/v1/applications/"));
  assert.ok(lastRead < repoPatch, "the repo turns read-only only after both stops are confirmed");

  let t = 0;
  const u = await setup({ sleep: async (ms) => { t += ms; }, now: () => t, confirmMs: 10000, pollMs: 2000 });
  u.fake.stopReads.set("app-preview-1", 1000);
  u.fake.stopReads.set("app-live-1", 1000);
  await assert.rejects(archiveProject(P.id, { ...u.base, authorize: allowAll }), TeardownError);
  assert.ok(!u.fake.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/repos/")), "the repo was not archived");
  assert.equal(u.store.projects.get(P.id).stage, "live");
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

// DEVOS-235: the Coolify token-scope preflight.
const coolifyCheck = (s) => coolifyTokenScopeCheck(s.cf, () => s.store.activeResources(P.id));

test("DEVOS-235: a Coolify token for another team stops the purge (provider_forbidden) with zero deletes", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.coolify.wrongTeam = true;
  // Without the preflight, this token would make every Coolify row look gone (the gap the check closes).
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] }),
    (e) => e instanceof TeardownError && e.code === "provider_forbidden" && e.retryable === false && /coolify-token-scope/.test(e.message),
  );
  assert.equal(s.fake.deletes().length, 0, "nothing deleted");
  assert.ok(s.store.resources.every((r) => !r.deletedAt), "every row stays active");
  assert.equal(s.fake.apps.size, 2);
  assert.equal(s.store.projects.get(P.id).stage, "archived");
});

test("DEVOS-235: the right team's token passes the preflight and the purge reaches 0", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] });
  assert.equal(out.purged, true, JSON.stringify(out.report));
});

test("DEVOS-235: a 5xx on the preflight read stops the purge retryable, never as a scope problem; nothing deleted", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.coolify.projectStatus = 503;
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] }),
    (e) => e instanceof TeardownError && e.code === "provider_error" && e.retryable === true,
  );
  assert.equal(s.fake.deletes().length, 0);
});

test("DEVOS-235: an inconclusive 200 (another uuid) or a non-uuid recorded id stops the purge with zero deletes", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const rows = await s.store.activeResources(P.id);
  const swapped = async () => rows.map((r) => (r.provider === "coolify" && r.kind === "project" ? { ...r, externalId: "not/a uuid" } : r));
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyTokenScopeCheck(s.cf, swapped)] }),
    (e) => e instanceof TeardownError && e.code === "provider_forbidden",
  );
  const proj = rows.find((r) => r.provider === "coolify" && r.kind === "project");
  const real = s.fake.projects.get(proj.externalId);
  const other = async () => rows.map((r) => (r === proj ? { ...r, externalId: "aaaaaaaa-0000-4000-8000-000000000000" } : r));
  s.fake.projects.set("aaaaaaaa-0000-4000-8000-000000000000", { ...real, uuid: "bbbbbbbb-0000-4000-8000-000000000000" });
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyTokenScopeCheck(s.cf, other)] }),
    (e) => e instanceof TeardownError && e.code === "provider_forbidden" && /inconclusive/.test(e.message),
  );
  assert.equal(s.fake.deletes().length, 0);
  assert.throws(() => coolifyTokenScopeCheck(s.cf, null), /coolify-recorded-invalid/);
});

test("DEVOS-235: with no active Coolify project row there is nothing to prove; the check makes no call", async () => {
  const s = await setup();
  const before = s.fake.calls.length;
  await coolifyTokenScopeCheck(s.cf, async () => [])();
  assert.equal(s.fake.calls.length, before);
});

test("DEVOS-235 pre-review: a 403 on the preflight read stops the purge as provider_forbidden, not retryable, zero deletes", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.coolify.projectStatus = 403;
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] }),
    (e) => e instanceof TeardownError && e.code === "provider_forbidden" && e.retryable === false,
  );
  assert.equal(s.fake.deletes().length, 0);
});

test("DEVOS-235 pre-review: a purge built on pinnedCoolify keeps the preflight's token even if the vault token changes", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  let token = TOKEN;
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => token, fetchImpl: s.fake.fetchImpl, sleep: async () => {} });
  const pinned = await pinnedCoolify(cf);
  token = OTHER_TEAM; // swapped in the vault after the pin: unpinned calls would see every uuid as gone
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: s.fake.fetchImpl, sleep: async () => {} });
  const ops = [githubRepoOps(gh, P.id), coolifyProjectOps(pinned, P.id), coolifyEnvironmentOps(pinned, P.id), coolifyPortOps(), coolifyApplicationOps(pinned, P.id, { sleep: async () => {} })];
  const scanners = [githubScanner(gh), coolifyScanner(pinned), inventoryScanner(s.store), s.store.vaultScanner()];
  const before = s.fake.calls.length;
  const out = await purgeProject(P.id, { ...s.base, ops, authorize: allowAll, scanners, preflight: [coolifyTokenScopeCheck(pinned, () => s.store.activeResources(P.id))] });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  const cfCalls = s.fake.calls.slice(before).filter((c) => c.path.startsWith("/api/v1/"));
  assert.ok(cfCalls.length > 0 && cfCalls.every((c) => c.auth === `Bearer ${TOKEN}`), "every Coolify call used the pinned token");
  assert.equal(s.fake.apps.size, 0, "the applications were really deleted");

  // Control: the same swap without the pin makes the preflight fail closed, nothing deleted.
  const u = await setup();
  await archiveProject(P.id, { ...u.base, authorize: allowAll });
  let t2 = TOKEN;
  const cf2 = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => t2, fetchImpl: u.fake.fetchImpl, sleep: async () => {} });
  t2 = OTHER_TEAM;
  await assert.rejects(
    purgeProject(P.id, { ...u.base, authorize: allowAll, scanners: u.scanners, preflight: [coolifyTokenScopeCheck(cf2, () => u.store.activeResources(P.id))] }),
    (e) => e.code === "provider_forbidden",
  );
  assert.equal(u.fake.deletes().length, 0);
});

test("Codex PR160-r1 (AT4): a purge that crashed after deleting the Coolify project resumes; the preflight does not block it", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  // Crash between the Coolify project's DELETE and its inventory update (the window Codex found).
  const orig = s.store.markResourceDeleted.bind(s.store);
  s.store.markResourceDeleted = async (id, at) => {
    const row = s.store.resources.find((r) => r.id === id);
    if (row.provider === "coolify" && row.kind === "project") throw new Error("simulated crash before the inventory update");
    return orig(id, at);
  };
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] }), /simulated crash/);
  s.store.markResourceDeleted = orig;
  const row = s.store.resources.find((r) => r.provider === "coolify" && r.kind === "project");
  assert.equal(s.fake.projects.has(row.externalId), false, "the Coolify project is gone at Coolify");
  assert.ok(!row.deletedAt && row.deleteStartedAt instanceof Date, "its row is still active, with the delete recorded as started");
  // Restart: the 404 for that row is its own earlier delete, so the preflight skips it and the purge finishes.
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  assert.equal(s.store.projects.get(P.id).stage, "purged");
});

test("Codex PR160-r1: the delete is recorded as started before its DELETE is sent; a never-started row still needs its 200", async () => {
  const s = await setup();
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const order = [];
  const origStart = s.store.markDeleteStarted.bind(s.store);
  s.store.markDeleteStarted = async (id, at) => { order.push({ id, deletesBefore: s.fake.deletes().length }); return origStart(id, at); };
  await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners, preflight: [coolifyCheck(s)] });
  assert.ok(order.length > 0);
  order.forEach((o, i) => assert.equal(o.deletesBefore, i, `start ${i} recorded before its own DELETE`));

  // A recorded project row without a started delete: a 404 is still a wrong-team token.
  const u = await setup();
  const rows = (await u.store.activeResources(P.id)).filter((r) => r.provider === "coolify" && r.kind === "project");
  assert.ok(rows.length === 1 && rows[0].deleteStartedAt === null);
  u.fake.coolify.wrongTeam = true;
  await assert.rejects(coolifyTokenScopeCheck(u.cf, async () => rows)(), /coolify-token-scope/);
  await coolifyTokenScopeCheck(u.cf, async () => [{ ...rows[0], deleteStartedAt: new Date() }])();
});
