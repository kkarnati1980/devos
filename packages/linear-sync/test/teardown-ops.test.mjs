// M2.6-b2b2 (DEVOS-247) AT7 (unit): archive marks the Linear project completed, restore starts it again, purge
// archives it (never deletes it); every write runs under the sync's per-project advisory lock; errors carry fixed text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient, LinearError, LINEAR_KEY_NOT_SET, graphqlApi, linearTeardownOps, linearScanner, withSyncLock, TEARDOWN_LOCK_WAIT_MS } from "../dist/index.js";

const PID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

class FakeProviderError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const makeError = (code, message, status) => new FakeProviderError(code, message, status);

/** A fake Prisma client: records the lock transaction's statements, and whether a write ran inside it. */
function fakeDb({ lockFails = false } = {}) {
  const db = { log: [], inTx: false };
  db.$transaction = async (fn, opts) => {
    db.log.push(["tx", opts]);
    const tx = {
      $executeRawUnsafe: async (sql) => { db.log.push(["exec", sql]); },
      $queryRawUnsafe: async (sql, ...args) => { db.log.push(["query", sql, ...args]); if (lockFails === "timeout") throw Object.assign(new Error("db error"), { cause: { code: "55P03" } }); if (lockFails) throw new Error("connection lost"); return [{ locked: 1 }]; },
    };
    db.inTx = true;
    try { return await fn(tx); } finally { db.inTx = false; }
  };
  return db;
}

function fakeApi(db, project = { id: "lp1", description: `Mirror\n\ndevos-ref: project/${PID}`, archivedAt: null }) {
  const L = { writes: [], project };
  L.api = {
    teamId: async () => "team-1",
    findProjects: async (_t, pid) => [L.project, ...(L.extra ?? [])].filter((p) => p && p.description.includes(`project/${pid}`)).map((p) => ({ id: p.id, archivedAt: p.archivedAt })),
    projectState: async (id) => (L.project && L.project.id === id ? { ...L.project } : null),
    projectStatusId: async (type) => { L.reads = (L.reads ?? []).concat([["statusId", type, db.inTx]]); return `st-${type}`; },
    updateProjectStatus: async (id, sid) => { L.writes.push(["status", id, sid.slice(3), db.inTx]); },
    archiveProject: async (id) => { L.writes.push(["archive", id, db.inTx]); L.project.archivedAt = "2026-11-17T00:00:00Z"; },
  };
  return L;
}

const row = { provider: "linear", kind: "project", externalId: "lp1", name: PID };

test("AT7: archive marks the Linear project completed, inside the sync's advisory lock for this project", async () => {
  const db = fakeDb(); const L = fakeApi(db);
  const [project] = linearTeardownOps(db, L.api, PID, makeError);
  assert.deepEqual(await project.inspect(row), { owned: true });
  await project.archive(row);
  assert.deepEqual(L.writes, [["status", "lp1", "completed", true]]);
  assert.deepEqual(L.reads, [["statusId", "completed", false]], "the status read runs before the lock, not inside it");
  const q = db.log.find((x) => x[0] === "query");
  assert.match(q[1], /pg_advisory_xact_lock\(hashtext\('devos:linear-sync'\), hashtext\(\$1\)\)/);
  assert.match(q[1], /^SELECT 1 AS locked FROM \(SELECT pg_advisory_xact_lock/);
  assert.equal(q[2], PID);
  assert.ok(db.log.some((x) => x[0] === "exec" && x[1] === `SET LOCAL lock_timeout = ${TEARDOWN_LOCK_WAIT_MS}`));
});

test("AT7: restore marks it started again, under the same lock", async () => {
  const db = fakeDb(); const L = fakeApi(db);
  const [project] = linearTeardownOps(db, L.api, PID, makeError);
  await project.unarchive(row);
  assert.deepEqual(L.writes, [["status", "lp1", "started", true]]);
});

test("AT7: purge archives the Linear project (no delete); afterwards it reads as removed, so a re-run writes nothing", async () => {
  const db = fakeDb(); const L = fakeApi(db);
  const [project] = linearTeardownOps(db, L.api, PID, makeError);
  await project.remove(row);
  assert.deepEqual(L.writes, [["archive", "lp1", true]]);
  assert.equal(await project.inspect(row), null);
  assert.equal(Object.keys(L.api).some((k) => /delete/i.test(k)), false);
});

test("AT7: ownership needs both the marker and the row's name; a project gone from Linear reads as removed", async () => {
  const db = fakeDb();
  const [mine] = linearTeardownOps(db, fakeApi(db).api, PID, makeError);
  assert.deepEqual(await mine.inspect({ ...row, name: OTHER }), { owned: false });
  const foreign = fakeApi(db, { id: "lp1", description: `devos-ref: project/${OTHER}`, archivedAt: null });
  const [p2] = linearTeardownOps(db, foreign.api, PID, makeError);
  assert.deepEqual(await p2.inspect(row), { owned: false });
  const gone = fakeApi(db, null);
  const [p3] = linearTeardownOps(db, gone.api, PID, makeError);
  assert.equal(await p3.inspect(row), null);
});

test("AT7: a milestone row has nothing of its own to remove (it is archived with its project)", async () => {
  const db = fakeDb();
  const [, milestone] = linearTeardownOps(db, fakeApi(db).api, PID, makeError);
  assert.equal(milestone.provider, "linear"); assert.equal(milestone.kind, "milestone");
  assert.equal(await milestone.inspect({ provider: "linear", kind: "milestone", externalId: "m1", name: OTHER }), null);
  assert.equal(milestone.archive, undefined);
});

test("errors: Linear failures map to provider errors with fixed text; transient ones stay transient; a held lock is a timeout", async () => {
  const db = fakeDb(); const L = fakeApi(db);
  const [project] = linearTeardownOps(db, L.api, PID, makeError);
  L.api.updateProjectStatus = async () => { throw new LinearError("graphql", "Linear says: <secret-looking text>"); };
  await assert.rejects(project.archive(row), (e) => e instanceof FakeProviderError && e.code === "bad-response" && !/secret/.test(e.message));
  L.api.archiveProject = async () => { throw new LinearError("timeout", "slow"); };
  await assert.rejects(project.remove(row), (e) => e.code === "timeout");
  L.api.projectState = async () => { throw new LinearError("http", "x", 503); };
  await assert.rejects(project.inspect(row), (e) => e.code === "http" && e.status === 503);
  L.api.projectState = async () => { throw new LinearError("rate-limited", "x"); };
  await assert.rejects(project.inspect(row), (e) => e.code === "http" && e.status === 429);
  L.api.projectState = async () => { throw new Error("linear-key-not-set"); };
  await assert.rejects(project.inspect(row), (e) => e.code === "no-token");
  const busy = fakeDb({ lockFails: "timeout" }); const B = fakeApi(busy);
  const [p2] = linearTeardownOps(busy, B.api, PID, makeError);
  await assert.rejects(p2.archive(row), (e) => e.code === "timeout" && /lock/.test(e.message));
  assert.deepEqual(B.writes, []);
  // Pre-review 1: any other lock-query failure is not read as "busy" (not transient, no lock wording).
  const broken = fakeDb({ lockFails: "other" }); const K = fakeApi(broken);
  const [p3] = linearTeardownOps(broken, K.api, PID, makeError);
  await assert.rejects(p3.archive(row), (e) => e.code === "bad-response" && !/lock/.test(e.message));
  assert.deepEqual(K.writes, []);
});

test("DEVOS-97 (Codex PR185-r1): a missing Linear key is no-token through the real LinearClient, for every op and the scan", async () => {
  const calls = [];
  const client = new LinearClient({ apiKey: async () => { throw new Error(LINEAR_KEY_NOT_SET); },
    fetchImpl: async (...a) => { calls.push(a); return new Response("{}", { status: 200 }); }, sleep: async () => {} });
  const api = graphqlApi(client);
  const db = fakeDb();
  const [project] = linearTeardownOps(db, api, PID, makeError);
  const noToken = (e) => e instanceof FakeProviderError && e.code === "no-token" && /key is not set/.test(e.message);
  await assert.rejects(project.inspect(row), noToken);
  await assert.rejects(project.archive(row), noToken);
  await assert.rejects(project.unarchive(row), noToken);
  await assert.rejects(project.remove(row), noToken);
  await assert.rejects(linearScanner(api, "DEVOS", makeError).scan({ id: PID, slug: "demo" }), noToken);
  assert.equal(calls.length, 0, "nothing is sent to Linear without a key");
  // A vault that fails for another reason is still bad-response (not no-token).
  const broken = graphqlApi(new LinearClient({ apiKey: async () => { throw new Error("vault down"); }, fetchImpl: async () => new Response("{}"), sleep: async () => {} }));
  const [p2] = linearTeardownOps(db, broken, PID, makeError);
  await assert.rejects(p2.inspect(row), (e) => e.code === "bad-response");
});

test("pre-review r2: the write is fenced: refused (busy, retryable, nothing written) once less than the write margin is left", async () => {
  const db = fakeDb(); let t = 0; let wrote = false;
  await assert.rejects(withSyncLock(db, PID, async (guard) => { t = 70_000; await guard(); wrote = true; }, { waitMs: 60_000, txMs: 120_000, now: () => t }), /linear-sync-lock-busy/);
  assert.equal(wrote, false);
  t = 0;
  await withSyncLock(db, PID, async (guard) => { t = 50_000; await guard(); wrote = true; }, { waitMs: 60_000, txMs: 120_000, now: () => t });
  assert.equal(wrote, true);
  assert.ok(db.log.some((x) => x[0] === "query" && x[1] === "SELECT 1"), "the guard pings the lock's transaction");
});

test("withSyncLock refuses bounds where the transaction cannot outlive the wait", async () => {
  await assert.rejects(withSyncLock(fakeDb(), PID, async () => {}, { waitMs: 1000, txMs: 1000 }), /bounds/);
});

test("leftover scan: an unarchived Linear project with this project's marker is a hit; an archived one is not; a failed read is a fixed-text error", async () => {
  const db = fakeDb(); const L = fakeApi(db);
  const s = linearScanner(L.api, "DEVOS", makeError);
  assert.equal(s.name, "linear");
  assert.deepEqual(await s.scan({ id: PID, slug: "demo" }), [{ provider: "linear", kind: "project", externalId: "lp1", name: PID }]);
  assert.deepEqual(await s.scan({ id: OTHER, slug: "other" }), []);
  L.project.archivedAt = "2026-11-17T00:00:00Z";
  assert.deepEqual(await s.scan({ id: PID, slug: "demo" }), []);
  // Pre-review 2: a second, unarchived project with the same marker is still a hit.
  L.extra = [{ id: "lp2", description: `devos-ref: project/${PID}`, archivedAt: null }];
  assert.deepEqual(await s.scan({ id: PID, slug: "demo" }), [{ provider: "linear", kind: "project", externalId: "lp2", name: PID }]);
  L.api.teamId = async () => { throw new LinearError("graphql", "Linear text"); };
  await assert.rejects(s.scan({ id: PID, slug: "demo" }), (e) => e.code === "bad-response" && !/Linear text/.test(e.message));
});

function gql(handler) {
  const calls = [];
  const fetchImpl = async (_u, init) => { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify({ data: handler(b) }), { status: 200 }); };
  return { a: graphqlApi(new LinearClient({ apiKey: () => "k", fetchImpl, sleep: async () => {} })), calls };
}

test("GraphQL: the status id is the lowest-position workspace status of the type; the write sends it; archive uses projectArchive", async () => {
  const { a, calls } = gql((b) => (/projectStatuses/.test(b.query)
    ? { projectStatuses: { nodes: [{ id: "st-late", type: "completed", position: 5 }, { id: "st-done", type: "completed", position: 1 }, { id: "st-go", type: "started", position: 0 }] } }
    : /projectUpdate/.test(b.query) ? { projectUpdate: { success: true } } : { projectArchive: { success: true } }));
  assert.equal(await a.projectStatusId("completed"), "st-done");
  await a.updateProjectStatus("lp1", "st-done");
  assert.deepEqual(calls[1].variables, { id: "lp1", i: { statusId: "st-done" } });
  await a.archiveProject("lp1");
  assert.match(calls[2].query, /projectArchive\(id: \$id\)/);
  assert.deepEqual(calls[2].variables, { id: "lp1" });
});

test("GraphQL: no status of the type, or a refused archive, fails closed", async () => {
  const { a } = gql((b) => (/projectStatuses/.test(b.query) ? { projectStatuses: { nodes: [{ id: "st-go", type: "started", position: 0 }] } } : { projectArchive: { success: false } }));
  await assert.rejects(a.projectStatusId("completed"), /no Linear project status/);
  await assert.rejects(a.archiveProject("lp1"), /refused/);
});

test("GraphQL: projectState reads archivedAt (archived included); teamId fails without a team; findProjects returns every marked project", async () => {
  const { a, calls } = gql((b) => (/teams\(/.test(b.query) ? { teams: { nodes: [] } }
    : /team\(id/.test(b.query) ? (b.variables.after
      ? { team: { projects: { nodes: [{ id: "lp3", description: `devos-ref: project/${PID}`, archivedAt: null }], pageInfo: { hasNextPage: false } } } }
      : { team: { projects: { nodes: [{ id: "lp1", description: `devos-ref: project/${PID}`, archivedAt: "2026-11-17T00:00:00Z" }, { id: "lp2", description: `devos-ref: project/${OTHER}`, archivedAt: null }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } })
    : { projects: { nodes: [{ id: "lp1", description: null, archivedAt: "2026-11-17T00:00:00Z" }] } }));
  assert.deepEqual(await a.projectState("lp1"), { id: "lp1", description: null, archivedAt: "2026-11-17T00:00:00Z" });
  assert.match(calls[0].query, /includeArchived: true/);
  await assert.rejects(a.teamId("DEVOS"), /no Linear team/);
  assert.deepEqual(await a.findProjects("team-1", PID), [{ id: "lp1", archivedAt: "2026-11-17T00:00:00Z" }, { id: "lp3", archivedAt: null }]);
});
