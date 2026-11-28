// M2.5-a2 on Postgres through the M1.1 Prisma client (teardown-db workflow): AT1, AT2, AT4, AT6 and AT7 against the real
// schema, with M2.4's fake GitHub and Coolify.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, runProvision,
  githubRepoOps, coolifyProjectOps, githubScanner, coolifyScanner,
} from "@devos/provision";
import { archiveProject, restoreProject, purgeProject, inventoryScanner, vaultScanner, PrismaTeardownStore } from "../dist/index.js";
import { fakeProviders } from "../../provision/test/fakes.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

async function setup() {
  const slug = `td-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug, stage: "live" } });
  const fake = fakeProviders();
  // Teardown endpoints on top of M2.4's fakes.
  const base = fake.fetchImpl;
  const deletes = [];
  const fetchImpl = async (u, init = {}) => {
    const url = new URL(u); const m = init.method ?? "GET"; let x;
    if (url.origin === "https://api.github.com" && (x = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && (m === "PATCH" || m === "DELETE")) {
      const key = `${x[1]}/${x[2]}`.toLowerCase(); const r = fake.repos.get(key);
      if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (m === "DELETE") { deletes.push(url.pathname); fake.repos.delete(key); return new Response(null, { status: 204 }); }
      Object.assign(r, JSON.parse(init.body)); return new Response(JSON.stringify(r), { status: 200 });
    }
    if (url.origin === "https://api.github.com" && m === "GET" && url.pathname === "/user/repos") {
      return new Response(JSON.stringify(url.searchParams.get("page") === "1" ? [...fake.repos.values()] : []), { status: 200 });
    }
    if (url.origin === "http://coolify.test:8000" && m === "DELETE" && (x = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
      if (!fake.projects.has(x[1])) return new Response(JSON.stringify({ message: "Project not found." }), { status: 404 });
      deletes.push(url.pathname); fake.projects.delete(x[1]); return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }
    return base(u, init);
  };
  const gh = new GitHubClient({ token: () => "t", fetchImpl, sleep: async () => {} });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => "t", fetchImpl, sleep: async () => {} });
  const store = new PrismaTeardownStore(db, { databaseUrl: url });
  const steps = () => [githubRepoStep(gh, p, "kkarnati1980"), coolifyProjectStep(cf, p)];
  const ops = [githubRepoOps(gh, p.id), coolifyProjectOps(cf, p.id)];
  const scanners = [githubScanner(gh), coolifyScanner(cf), inventoryScanner(store), vaultScanner(db)];
  return { p, fake, store, steps, ops, scanners, deletes, provision: () => runProvision(p.id, steps(), { store, authorize: allowAll }) };
}

test("AT1 on Postgres: create → archive → purge → scan 0; rows deleted, steps reset, stage purged, scan stored", async () => {
  const s = await setup();
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  let row = await db.project.findUnique({ where: { id: s.p.id } });
  assert.equal(row.stage, "archived");
  assert.equal(row.purgeAfter.getTime() - row.archivedAt.getTime(), 30 * 86_400_000);
  const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  row = await db.project.findUnique({ where: { id: s.p.id } });
  assert.equal(row.stage, "purged");
  assert.equal(await db.resource.count({ where: { projectId: s.p.id, status: "active" } }), 0);
  assert.equal(await db.provisionStep.count({ where: { projectId: s.p.id } }), 0);
  const scan = await s.store.lastScan(s.p.id);
  assert.deepEqual(scan.hits, []);
  assert.equal(await db.auditEvent.count({ where: { projectId: s.p.id, action: "teardown.purged" } }), 1);
});

test("AT2 on Postgres: restore returns to the stage before archive", async () => {
  const s = await setup();
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  assert.equal((await s.store.project(s.p.id)).previousStage, "live");
  await restoreProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  const row = await db.project.findUnique({ where: { id: s.p.id } });
  assert.equal(row.stage, "live");
  assert.equal(row.archivedAt, null);
  assert.equal(s.deletes.length, 0);
});

test("AT4 on Postgres: a crash after each provider delete and before the row update; the re-run finishes", async () => {
  for (let k = 0; k < 2; k++) {
    const s = await setup();
    await s.provision();
    await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
    let n = 0; const orig = s.store.markResourceDeleted.bind(s.store);
    s.store.markResourceDeleted = async (id, at) => { if (n++ === k) throw new Error("simulated crash"); return orig(id, at); };
    await assert.rejects(purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll }), /simulated crash/);
    s.store.markResourceDeleted = orig;
    // Codex PR160-r1: the crashed row is still active and carries the start of its delete.
    const started = (await s.store.activeResources(s.p.id)).filter((r) => r.deleteStartedAt instanceof Date);
    assert.equal(started.length, 1, "the crashed row records its delete start");
    const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll });
    assert.equal(out.purged, true);
    assert.equal(s.deletes.length, 2, "each resource deleted once");
  }
});

test("AT7 on Postgres: after a purge the same project provisions fresh; its own deleted rows come back active", async () => {
  const s = await setup();
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll });
  const out = await s.provision();
  assert.deepEqual(out.map((o) => o.outcome), ["created", "created"]);
  assert.equal(await db.resource.count({ where: { projectId: s.p.id, status: "active" } }), 2);
  // Codex PR160-r1: a revived row starts with no recorded delete.
  assert.equal(await db.resource.count({ where: { projectId: s.p.id, status: "active", deleteStartedAt: { not: null } } }), 0);
});

test("DEVOS-131 on Postgres: purge deletes the project's vault secrets (only this project's) and ends purged", async () => {
  const s = await setup();
  const other = await setup();
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  const mk = (projectId, name) => db.vaultSecret.create({ data: { projectId, name, ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), keyVersion: 1 } });
  await mk(s.p.id, "APP_SESSION_SECRET");
  await mk(s.p.id, "DB_PASSWORD");
  await mk(other.p.id, "APP_SESSION_SECRET");
  const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll });
  assert.equal(out.secretsDeleted, 2);
  assert.equal(out.purged, true);
  assert.equal(await db.vaultSecret.count({ where: { projectId: s.p.id } }), 0);
  assert.equal(await db.vaultSecret.count({ where: { projectId: other.p.id } }), 1);
  const ev = await db.auditEvent.findFirst({ where: { projectId: s.p.id, action: "teardown.secrets_deleted" } });
  assert.deepEqual(ev.details, { count: 2, names: ["APP_SESSION_SECRET", "DB_PASSWORD"] });
  assert.ok(!JSON.stringify(ev).includes("ciphertext"));
});

test("DEVOS-175 on Postgres: purge deletes the project's isolation_stack rows with the purge, freeing the index for a new project", async () => {
  const s = await setup();
  const other = await setup();
  await s.provision();
  // Three indexes no row holds yet (the index, subnet and network are unique across all stacks in the database).
  // 512–1023 only keeps clear of low indexes other fixtures might use; the read-then-insert is safe because the
  // teardown-db job runs its tests one at a time on its own database.
  const taken = new Set((await db.isolationStack.findMany({ select: { idx: true } })).map((r) => r.idx));
  const start = randomBytes(2).readUInt16BE(0) % 512;
  const free = [];
  for (let k = 0; k < 512 && free.length < 3; k++) { const i = 512 + ((start + k) % 512); if (!taken.has(i)) free.push(i); }
  assert.equal(free.length, 3, "no free isolation index left in 512–1023 on the test database");
  const [idx, idxLive, idxOther] = free;
  // network and subnet as the migration's checks derive them (isolation_stack_network_derived / _subnet_derived).
  const stack = (projectId, slug, env, i) => ({ projectId, slug, env, idx: i, network: `devos-p-${slug}-${env}`, subnet: `10.${208 + Math.floor(i / 256)}.${i % 256}.0/24` });
  await db.isolationStack.create({ data: stack(s.p.id, s.p.slug, "preview", idx) });
  await db.isolationStack.create({ data: stack(s.p.id, s.p.slug, "live", idxLive) });
  await db.isolationStack.create({ data: stack(other.p.id, other.p.slug, "preview", idxOther) });
  const otherBefore = await db.isolationStack.count({ where: { projectId: other.p.id } });
  // While s holds the index, a new project cannot take it.
  const late = await setup();
  await assert.rejects(db.isolationStack.create({ data: stack(late.p.id, late.p.slug, "preview", idx) }), (e) => e.code === "P2002");
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  // Archive alone keeps the stacks (a restore needs them).
  assert.equal(await db.isolationStack.count({ where: { projectId: s.p.id } }), 2);
  const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: s.scanners, authorize: allowAll });
  assert.equal(out.purged, true, JSON.stringify(out.report));
  assert.equal(await db.isolationStack.count({ where: { projectId: s.p.id } }), 0);
  assert.equal(await db.isolationStack.count({ where: { projectId: other.p.id } }), otherBefore);
  const ev = await db.auditEvent.findFirst({ where: { projectId: s.p.id, action: "teardown.purged" } });
  assert.deepEqual(ev.details, { isolationStacksDeleted: 2 });
  // The freed index, subnet and network can now be recorded by the new project.
  const freed = stack(late.p.id, late.p.slug, "preview", idx);
  const row = await db.isolationStack.create({ data: freed });
  assert.equal(row.idx, idx);
  assert.equal(row.subnet, freed.subnet);
});

test("AT6 on Postgres: a vault secret left for the project is a leftover (listed by name, never by value); the stage stays archived", async () => {
  const s = await setup();
  // Simulates a secret that survives the delete (e.g. written by a racing writer): the scan must still see it.
  s.store.deleteProjectSecrets = async () => 0;
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  await db.vaultSecret.create({ data: { projectId: s.p.id, name: "APP_SESSION_SECRET", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), keyVersion: 1 } });
  // The scanner must never select the ciphertext or nonce (decision 7).
  const selects = [];
  const spyDb = { vaultSecret: { findMany: (q) => { selects.push(q.select); return db.vaultSecret.findMany(q); } } };
  const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: [...s.scanners.filter((x) => x.name !== "vault"), vaultScanner(spyDb)], authorize: allowAll });
  assert.equal(selects.length, 1);
  assert.deepEqual(Object.keys(selects[0]).sort(), ["id", "name"]);
  assert.equal(out.purged, false);
  assert.deepEqual(out.report.hits.map((h) => `${h.provider}:${h.name}`), ["vault:APP_SESSION_SECRET"]);
  assert.equal((await db.project.findUnique({ where: { id: s.p.id } })).stage, "archived");
});

test("M2.5-b5b decisions 1–2: Archive stamps archived_at from the database clock in whole ms and returns what it stored", async () => {
  const s = await setup();
  await s.provision();
  // The app clock is pinned far from Postgres: it only carries the 30-day window.
  const appNow = Date.parse("2001-01-01T00:00:00Z");
  const before = (await db.$queryRaw`SELECT clock_timestamp() AS t`)[0].t.getTime();
  const out = await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll, now: () => appNow });
  const afterT = (await db.$queryRaw`SELECT clock_timestamp() AS t`)[0].t.getTime();
  const row = await db.project.findUnique({ where: { id: s.p.id } });
  assert.deepEqual(out, { archivedAt: row.archivedAt, purgeAfter: row.purgeAfter }, "the times the row holds");
  assert.ok(row.archivedAt.getTime() >= before - 1 && row.archivedAt.getTime() <= afterT, "the database clock, not 2001");
  assert.equal(row.purgeAfter.getTime() - row.archivedAt.getTime(), 30 * 86_400_000);
  const ms = (await db.$queryRaw`SELECT (archived_at = date_trunc('milliseconds', archived_at)) AS a, (purge_after = date_trunc('milliseconds', purge_after)) AS b FROM project WHERE id = ${s.p.id}::uuid`)[0];
  assert.deepEqual([ms.a, ms.b], [true, true], "whole milliseconds, so the millisecond Date every reader gets equals the column");
  const exact = (await db.$queryRaw`SELECT (archived_at = ${out.archivedAt}::timestamptz) AS eq FROM project WHERE id = ${s.p.id}::uuid`)[0];
  assert.equal(exact.eq, true, "the returned snapshot passes the guarded raise's exact archive check");
  const ev = await db.auditEvent.findFirst({ where: { projectId: s.p.id, action: "teardown.archived" } });
  assert.equal(ev.details.purgeAfter, row.purgeAfter.toISOString());
});

test("M2.5-b5b decision 11 (Codex PR244-r1): a new Archive retires every earlier purge card: grants revoked, pending expired", async () => {
  const s = await setup();
  await s.provision();
  const target = `project:${s.p.id}`;
  // From an earlier archive: an approved card with an unspent grant, and a pending one (app-clock times far ahead).
  const ahead = new Date(Date.now() + 10 * 60_000);
  const approved = await db.approval.create({ data: { projectId: s.p.id, gate: "purge", action: "teardown.purge", target, reason: "old", status: "approved", decidedAt: ahead, decidedBy: "kk", confirmationHash: "h", createdAt: ahead } });
  const grant = await db.approvalGrant.create({ data: { approvalId: approved.id, projectId: s.p.id, scopeAction: "teardown.purge", issuedBy: "kk:test", expiresAt: new Date(Date.now() + 86_400_000) } });
  const pending = await db.approval.create({ data: { projectId: s.p.id, gate: "purge", action: "teardown.purge", target, reason: "old pending", createdAt: ahead } });
  const otherAction = await db.approval.create({ data: { projectId: s.p.id, gate: "decision", action: "teardown.purge_stopped", target, reason: "not a purge card" } });
  // Decision 14 (Codex PR244-r2): an earlier rejection is retired by id, whatever its time.
  const rejectedOld = await db.approval.create({ data: { projectId: s.p.id, gate: "purge", action: "teardown.purge", target, reason: "old rejected", status: "rejected", decidedAt: ahead, decidedBy: "kk", createdAt: ahead } });
  const out = await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  const g = await db.approvalGrant.findUnique({ where: { id: grant.id } });
  assert.deepEqual(g.revokedAt, out.archivedAt, "the old card's unspent grant is revoked, though its time sorts after the archive");
  const p = await db.approval.findUnique({ where: { id: pending.id } });
  assert.equal(String(p.status), "expired");
  assert.equal(String((await db.approval.findUnique({ where: { id: approved.id } })).status), "approved", "a decided card keeps its status");
  assert.equal(String((await db.approval.findUnique({ where: { id: otherAction.id } })).status), "pending", "other actions are untouched");
  const ev = await db.auditEvent.findFirst({ where: { projectId: s.p.id, action: "teardown.archive_retired_cards" } });
  assert.deepEqual(ev.details, { grantsRevoked: 1, cardsExpired: 1, retired: [approved.id, pending.id, rejectedOld.id].sort() }, "every earlier purge card, any status, by id (decisions 14-15)");
  assert.equal(String((await db.approval.findUnique({ where: { id: rejectedOld.id } })).status), "rejected", "a retired rejection keeps its status");
  // b5b decision 20: the listing row is dated on the database clock, at this Archive's archived_at.
  const archivedRow = await db.project.findUnique({ where: { id: s.p.id }, select: { archivedAt: true } });
  assert.equal(ev.occurredAt.getTime(), archivedRow.archivedAt.getTime(), "occurred_at is the Archive's database time");
  // Decision 15: a later Archive lists only cards no earlier list holds.
  const fresh = await db.approval.create({ data: { projectId: s.p.id, gate: "purge", action: "teardown.purge", target, reason: "this archive's", status: "rejected", decidedAt: new Date(), decidedBy: "kk" } });
  await s.store.markArchived(s.p.id, new Date(), new Date(Date.now() + 30 * 86_400_000));
  const lists = await db.auditEvent.findMany({ where: { projectId: s.p.id, action: "teardown.archive_retired_cards" }, orderBy: { occurredAt: "asc" } });
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[1].details.retired, [fresh.id], "each id is listed once across archives");
});
