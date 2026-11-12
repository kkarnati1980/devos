// M2.5-a acceptance tests on fake providers (docs/modules/M2.5.md: AT1–AT8; AT3's purge-due job is M2.5-b).
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, runProvision,
  githubRepoOps, coolifyProjectOps, githubScanner, coolifyScanner,
} from "@devos/provision";
import { archiveProject, restoreProject, purgeProject, inventoryScanner, MemoryTeardownStore, TeardownError } from "../dist/index.js";
import { fakeProviders } from "../../provision/test/fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const DAY = 86_400_000;

/** M2.4's fakes plus the teardown endpoints: repo PATCH/DELETE, the repo list, Coolify project DELETE. */
function fakes() {
  const base = fakeProviders();
  const faults = []; // { match(method, path), action: "timeout-after" | "timeout-before" | { status }, used }
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const timeout = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; return e; };
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    let m;
    const handle = () => {
      if (u.origin === "https://api.github.com") {
        if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && (method === "PATCH" || method === "DELETE")) {
          const key = `${m[1]}/${m[2]}`.toLowerCase();
          const r = base.repos.get(key);
          if (!r) return json(404, { message: "Not Found" });
          if (method === "DELETE") { base.repos.delete(key); return new Response(null, { status: 204 }); }
          Object.assign(r, JSON.parse(init.body));
          return json(200, r);
        }
        if (method === "GET" && path === "/user/repos") {
          const page = Number(u.searchParams.get("page") ?? 1);
          return json(200, page === 1 ? [...base.repos.values()] : []);
        }
      }
      if (u.origin === "http://coolify.test:8000" && method === "DELETE" && (m = path.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
        if (!base.projects.has(m[1])) return json(404, { message: "Project not found." });
        base.projects.delete(m[1]);
        return json(200, { message: "Project deleted." });
      }
      return null;
    };
    const f = faults.find((x) => !x.used && x.match(method, path));
    if (f) f.used = true;
    calls.push({ method, path, auth: init.headers?.authorization, signal: init.signal });
    if (f?.action === "timeout-before") throw timeout();
    if (f?.action?.raw) return new Response(f.action.body === undefined ? null : f.action.body, { status: f.action.status });
    if (f?.action?.status) return json(f.action.status, { message: "injected" });
    const own = handle();
    const res = own ?? (await base.fetchImpl(url, init));
    if (f?.action === "timeout-after") throw timeout();
    return res;
  }
  const deletes = () => calls.filter((c) => c.method === "DELETE");
  return { ...base, fetchImpl, faults, calls, deletes };
}

function setup() {
  const fake = fakes();
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep });
  const store = new MemoryTeardownStore();
  store.addProject({ id: P.id, slug: P.slug, stage: "live" });
  const steps = (p = P) => [githubRepoStep(gh, p, "kkarnati1980"), coolifyProjectStep(cf, p)];
  const ops = [githubRepoOps(gh, P.id), coolifyProjectOps(cf, P.id)];
  const scanners = [githubScanner(gh), coolifyScanner(cf), inventoryScanner(store)];
  const t0 = Date.UTC(2026, 10, 12, 8, 0, 0);
  const base = { store, ops, now: () => t0 };
  return { fake, gh, cf, store, steps, ops, scanners, base, t0, sleeps };
}

const provision = (s) => runProvision(P.id, s.steps(), { store: s.store, authorize: allowAll });

test("AT1 create → archive → purge → the scan finds 0, every row deleted, stage purged", async () => {
  const s = setup();
  await provision(s);
  assert.equal(s.fake.repos.size, 1);
  assert.equal(s.fake.projects.size, 1);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.deleted, 2);
  assert.equal(out.purged, true);
  assert.deepEqual(out.report.hits, []);
  assert.deepEqual(out.report.errors, []);
  assert.equal(s.fake.repos.size, 0);
  assert.equal(s.fake.projects.size, 0);
  assert.ok(s.store.resources.every((r) => r.deletedAt));
  assert.equal((await s.store.project(P.id)).stage, "purged");
  // The repo goes last (decision table): Coolify first, then GitHub.
  assert.deepEqual(s.fake.deletes().map((c) => c.path.split("/")[1]), ["api", "repos"]);
  assert.equal(s.store.scans.length, 1);
});

test("AT2 archive is reversible: repo archived, nothing deleted, purge_after = archived_at + window; restore undoes it", async () => {
  const s = setup();
  await provision(s);
  const a = await archiveProject(P.id, { ...s.base, authorize: allowAll, windowDays: 30 });
  assert.equal(s.fake.repos.get("kkarnati1980/devos-acme").archived, true);
  assert.equal(a.purgeAfter.getTime() - a.archivedAt.getTime(), 30 * DAY);
  const p = await s.store.project(P.id);
  assert.equal(p.stage, "archived");
  assert.equal(p.previousStage, "live");
  await assert.rejects(archiveProject(P.id, { ...s.base, authorize: allowAll }), (e) => e instanceof TeardownError && e.code === "already_archived");
  await restoreProject(P.id, { ...s.base, authorize: allowAll });
  assert.equal(s.fake.repos.get("kkarnati1980/devos-acme").archived, false);
  assert.equal((await s.store.project(P.id)).stage, "live");
  assert.equal(s.fake.deletes().length, 0);
  assert.equal(s.fake.repos.size, 1);
  assert.equal(s.fake.projects.size, 1);
});

test("AT3 no purge without KK: require_approval or deny makes zero provider calls; a live project cannot be purged", async () => {
  const s = setup();
  await provision(s);
  const seen = [];
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e.code === "not_archived");
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const before = s.fake.calls.length;
  await assert.rejects(
    purgeProject(P.id, { ...s.base, scanners: s.scanners, authorize: async (a, r) => (seen.push([a, r]), "require_approval") }),
    (e) => e instanceof TeardownError && e.code === "approval_required" && e.retryable === false,
  );
  await assert.rejects(purgeProject(P.id, { ...s.base, scanners: s.scanners, authorize: async () => "deny" }), (e) => e.code === "policy_denied");
  assert.equal(s.fake.calls.length, before, "no provider call without an allow");
  assert.deepEqual(seen, [["teardown.purge", `project:${P.id}`]]);
  await assert.rejects(purgeProject(P.id, { ...s.base, scanners: s.scanners }), /authorize is required/);
});

test("AT4 a crash after each provider delete and before the row update: the re-run finishes, ≤ 2 deletes per resource", async () => {
  for (let k = 0; k < 2; k++) {
    const s = setup();
    await provision(s);
    await archiveProject(P.id, { ...s.base, authorize: allowAll });
    // Let k rows complete, then crash on the next row update.
    let n = 0;
    const orig = s.store.markResourceDeleted.bind(s.store);
    s.store.markResourceDeleted = async (id, at) => {
      if (n++ === k) throw new Error("simulated crash before the inventory update");
      return orig(id, at);
    };
    await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), /simulated crash/);
    s.store.markResourceDeleted = orig;
    const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
    assert.equal(out.purged, true, `k=${k}`);
    const perPath = {};
    for (const d of s.fake.deletes()) perPath[d.path] = (perPath[d.path] ?? 0) + 1;
    assert.ok(Object.values(perPath).every((c) => c <= 2), JSON.stringify(perPath));
    assert.equal(Object.keys(perPath).length, 2);
    assert.ok(s.store.resources.every((r) => r.deletedAt));
  }
});

test("AT5 a resource that lost its marker is not deleted: ownership_mismatch, non-retryable; the scan still lists it", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.repos.get("kkarnati1980/devos-acme").description = "someone else's repo now";
  await assert.rejects(
    purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }),
    (e) => e instanceof TeardownError && e.code === "ownership_mismatch" && e.retryable === false && e.resource.provider === "github",
  );
  assert.equal(s.fake.repos.size, 1, "the repo was not deleted");
  assert.ok(!s.fake.deletes().some((d) => d.path.startsWith("/repos/")));
  // A public repo is not ours either (decision 3), even with the marker.
  const s2 = setup();
  await provision(s2);
  await archiveProject(P.id, { ...s2.base, authorize: allowAll });
  s2.fake.repos.get("kkarnati1980/devos-acme").private = false;
  await assert.rejects(purgeProject(P.id, { ...s2.base, authorize: allowAll, scanners: s2.scanners }), (e) => e.code === "ownership_mismatch");
  // The scan finds it by name.
  const { scanLeftovers } = await import("../dist/index.js");
  const rep = await scanLeftovers(P, [githubScanner(s.gh)]);
  assert.deepEqual(rep.hits.map((h) => h.externalId), ["kkarnati1980/devos-acme"]);
});

test("AT6 a marked resource missing from the inventory is found by the scan; the stage stays archived", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  // Created at the provider with the marker, never recorded in the inventory.
  s.fake.projects.set("cfstray0001", { uuid: "cfstray0001", name: "stray", description: `left over devos:${P.id}` });
  s.fake.repos.set("kkarnati1980/other-name", { id: 99, name: "other-name", full_name: "kkarnati1980/other-name", private: true, description: `x devos:${P.id}` });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, false);
  assert.deepEqual(out.report.hits.map((h) => `${h.provider}:${h.externalId}`).sort(), ["coolify:cfstray0001", "github:kkarnati1980/other-name"]);
  assert.equal((await s.store.project(P.id)).stage, "archived");
  // A scanner that fails makes the report not clean either.
  const s2 = setup();
  await provision(s2);
  await archiveProject(P.id, { ...s2.base, authorize: allowAll });
  const broken = { name: "broken", scan: async () => { throw new Error("boom"); } };
  const out2 = await purgeProject(P.id, { ...s2.base, authorize: allowAll, scanners: [...s2.scanners, broken] });
  assert.equal(out2.purged, false);
  assert.deepEqual(out2.report.errors, [{ scanner: "broken", error: "boom" }]);
});

test("AT7 re-provision after purge: steps reset, the same slug provisions fresh resources", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(s.store.steps.size, 0, "provision_step rows reset");
  const NEW = { id: "22222222-2222-4333-8444-555555555555", slug: "acme", name: "Acme again" };
  const out = await runProvision(NEW.id, s.steps(NEW), { store: s.store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["created", "created"]);
  assert.equal(s.fake.repos.size, 1);
  assert.match(s.fake.repos.get("kkarnati1980/devos-acme").description, /devos:22222222/);
  assert.equal((await s.store.activeResources(NEW.id)).length, 2);
});

test("AT8 retries and timeouts: a timed-out delete that succeeded is confirmed by lookup; 503 lookups retry; 403 stops", async () => {
  // Timeout after the delete happened: confirmed by lookup, not repeated.
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.faults.push({ match: (m, p) => m === "DELETE" && p.startsWith("/repos/"), action: "timeout-after" });
  // One 503 on a lookup: the GET is retried with backoff.
  s.fake.faults.push({ match: (m, p) => m === "GET" && p.startsWith("/api/v1/projects/"), action: { status: 503 } });
  const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
  assert.equal(out.purged, true);
  assert.equal(s.fake.deletes().filter((d) => d.path.startsWith("/repos/")).length, 1);
  assert.ok(s.fake.faults.every((f) => f.used), "both injected faults fired");
  assert.equal(s.sleeps.length, 1, "the 503 lookup was retried once, after a backoff sleep");
  assert.ok(s.sleeps[0] > 0);

  // Timeout before the delete reached the provider: still there → delete_unconfirmed (retryable); the re-run deletes.
  const s2 = setup();
  await provision(s2);
  await archiveProject(P.id, { ...s2.base, authorize: allowAll });
  s2.fake.faults.push({ match: (m, p) => m === "DELETE" && p.startsWith("/repos/"), action: "timeout-before" });
  await assert.rejects(purgeProject(P.id, { ...s2.base, authorize: allowAll, scanners: s2.scanners }), (e) => e.code === "delete_unconfirmed" && e.retryable === true);
  const again = await purgeProject(P.id, { ...s2.base, authorize: allowAll, scanners: s2.scanners });
  assert.equal(again.purged, true);
  assert.equal(s2.fake.deletes().filter((d) => d.path.startsWith("/repos/")).length, 2);

  // 403 on the delete: provider_forbidden, no retry.
  const s3 = setup();
  await provision(s3);
  await archiveProject(P.id, { ...s3.base, authorize: allowAll });
  s3.fake.faults.push({ match: (m, p) => m === "DELETE" && p.startsWith("/repos/"), action: { status: 403 } });
  let err;
  await purgeProject(P.id, { ...s3.base, authorize: allowAll, scanners: s3.scanners }).catch((e) => { err = e; });
  assert.equal(err.code, "provider_forbidden");
  assert.equal(err.retryable, false);
  assert.equal(s3.fake.deletes().filter((d) => d.path.startsWith("/repos/")).length, 1);

  // No secret in any error, report or stored row; every call carried the token only in the auth header.
  const everything = JSON.stringify([err.message, err.resource, s.store.scans, s2.store.scans, [...s3.store.steps.values()], s3.store.resources]);
  assert.ok(!everything.includes(TOKEN));
  assert.ok(s.fake.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  // Every call carried a timeout signal (ADR-0011 §9).
  assert.ok([...s.fake.calls, ...s2.fake.calls, ...s3.fake.calls].every((c) => c.signal instanceof AbortSignal));
});

test("teardown refuses an inventory kind it cannot delete before deleting anything", async () => {
  const s = setup();
  await provision(s);
  await s.store.recordResource(P.id, { provider: "vault", kind: "secret", externalId: "APP_KEY", name: "APP_KEY" });
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e.code === "unsupported_resource");
  assert.equal(s.fake.deletes().length, 0);
});

test("pre-review 1: a purge that stops half way resets the steps, so Restore + re-provision recreates the deleted resource", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  s.fake.faults.push({ match: (m, p) => m === "DELETE" && p.startsWith("/repos/"), action: { status: 403 } });
  await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e.code === "provider_forbidden");
  assert.equal(s.fake.projects.size, 0, "the Coolify project was deleted first");
  assert.equal(s.store.steps.size, 0, "no stale done step");
  await restoreProject(P.id, { ...s.base, authorize: allowAll });
  const out = await provision(s);
  assert.deepEqual(out.map((o) => o.outcome), ["adopted", "created"]);
  assert.equal(s.fake.projects.size, 1);
});

test("pre-review 3: archive checks ownership of every resource before its first write", async () => {
  const s = setup();
  await provision(s);
  const cfOps = { provider: "coolify", kind: "project", inspect: async () => ({ owned: false }), remove: async () => {}, archive: async () => { throw new Error("must not run"); } };
  const ghFirst = [githubRepoOps(s.gh, P.id), cfOps];
  await assert.rejects(archiveProject(P.id, { ...s.base, ops: ghFirst, authorize: allowAll }), (e) => e.code === "ownership_mismatch");
  assert.notEqual(s.fake.repos.get("kkarnati1980/devos-acme").archived, true, "the repo was not archived");
  assert.equal(s.fake.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal((await s.store.project(P.id)).stage, "live");
});

test("Codex PR48-r1: a purge without a scanner per provider and the inventory scanner refuses before any call", async () => {
  const s = setup();
  await provision(s);
  await archiveProject(P.id, { ...s.base, authorize: allowAll });
  const before = s.fake.calls.length;
  for (const scanners of [[], [githubScanner(s.gh), coolifyScanner(s.cf)], [githubScanner(s.gh), inventoryScanner(s.store)]]) {
    await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners }), (e) => e instanceof TeardownError && e.code === "scan_incomplete" && e.retryable === false);
  }
  assert.equal(s.fake.calls.length, before, "no provider call");
  assert.equal((await s.store.project(P.id)).stage, "archived");
});

test("Codex PR48-r1: an inconclusive lookup (204, empty 200, JSON null, wrong shape) never marks a row deleted", async () => {
  for (const [status, body] of [[204, undefined], [200, ""], [200, "null"], [200, "[]"]]) {
    const s = setup();
    await provision(s);
    await archiveProject(P.id, { ...s.base, authorize: allowAll });
    s.fake.faults.push({ match: (m, p) => m === "GET" && p.startsWith("/repos/"), action: { raw: true, status, body } });
    await assert.rejects(purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners }), (e) => e.code === "provider_error", `${status} ${body}`);
    assert.equal(s.fake.repos.size, 1);
    assert.ok(s.store.resources.some((r) => r.provider === "github" && !r.deletedAt), "the repo row stays active");
  }
});

test("Codex PR48-r4: a malformed repo or project entry makes the scan inconclusive, never clean", async () => {
  const bad = [
    { gh: [{ full_name: "kkarnati1980/devos-acme", description: null }] },          // no name
    { gh: [{ full_name: "kkarnati1980/devos-acme", name: "other", description: null }] }, // name ≠ full_name
    { gh: [{ full_name: "kkarnati1980/devos-acme", name: "devos-acme", description: 7 }] },
    { cf: [{ uuid: "cf1", name: "x", description: { marker: true } }] },
    // Codex PR48-r5: an omitted description (a different name, so only the marker could match) is inconclusive.
    { gh: [{ full_name: "kkarnati1980/other", name: "other" }] },
    { cf: [{ uuid: "cf2", name: "other" }] },
  ];
  for (const b of bad) {
    const s = setup();
    await provision(s);
    await archiveProject(P.id, { ...s.base, authorize: allowAll });
    if (b.gh) s.fake.faults.push({ match: (m, p) => m === "GET" && p === "/user/repos", action: { raw: true, status: 200, body: JSON.stringify(b.gh) } });
    if (b.cf) s.fake.faults.push({ match: (m, p) => m === "GET" && p === "/api/v1/projects", action: { raw: true, status: 200, body: JSON.stringify(b.cf) } });
    const out = await purgeProject(P.id, { ...s.base, authorize: allowAll, scanners: s.scanners });
    assert.equal(out.purged, false, JSON.stringify(b));
    assert.equal(out.report.errors.length, 1);
    assert.equal((await s.store.project(P.id)).stage, "archived");
  }
});
