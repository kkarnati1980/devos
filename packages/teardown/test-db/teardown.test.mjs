// M2.5-a2 on Postgres through the M1.1 Prisma client (teardown-db workflow): AT1, AT4 and AT7 against the real
// schema, with M2.4's fake GitHub and Coolify.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import {
  allowAll, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, runProvision,
  githubRepoOps, coolifyProjectOps, githubScanner, coolifyScanner,
} from "@devos/provision";
import { archiveProject, restoreProject, purgeProject, inventoryScanner, PrismaTeardownStore } from "../dist/index.js";
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
  const scanners = [githubScanner(gh), coolifyScanner(cf), inventoryScanner(store)];
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
});

test("AT6 on Postgres: a vault secret left for the project is a leftover (listed by name, never by value); the stage stays archived", async () => {
  const { vaultScanner } = await import("../dist/index.js");
  const s = await setup();
  await s.provision();
  await archiveProject(s.p.id, { store: s.store, ops: s.ops, authorize: allowAll });
  await db.vaultSecret.create({ data: { projectId: s.p.id, name: "APP_SESSION_SECRET", ciphertext: Buffer.from("x"), nonce: Buffer.alloc(12), keyVersion: 1 } });
  const out = await purgeProject(s.p.id, { store: s.store, ops: s.ops, scanners: [...s.scanners, vaultScanner(db)], authorize: allowAll });
  assert.equal(out.purged, false);
  assert.deepEqual(out.report.hits.map((h) => `${h.provider}:${h.name}`), ["vault:APP_SESSION_SECRET"]);
  assert.ok(!JSON.stringify(out.report).includes("ciphertext"));
  assert.equal((await db.project.findUnique({ where: { id: s.p.id } })).stage, "archived");
});
