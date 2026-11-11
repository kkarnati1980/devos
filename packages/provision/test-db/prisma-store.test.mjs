// M2.4-a on Postgres through the M1.1 Prisma client (provision-db workflow): the step journal, the
// inventory upsert and the per-project advisory lock (AT1–AT3, AT8 against the real schema).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaStore, GitHubClient, CoolifyClient, githubRepoStep, coolifyProjectStep, runProvision } from "../dist/index.js";
import { fakeProviders } from "../test/fakes.mjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

async function seed() {
  const slug = `prov-${randomBytes(6).toString("hex")}`;
  return db.project.create({ data: { slug, name: slug } });
}
function steps(p, fake) {
  const gh = new GitHubClient({ token: () => "t", fetchImpl: fake.fetchImpl, sleep: async () => {} });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => "t", fetchImpl: fake.fetchImpl, sleep: async () => {} });
  return [githubRepoStep(gh, p, "kkarnati1980"), coolifyProjectStep(cf, p)];
}

test("AT1/AT2 on Postgres: resources and done steps are recorded; a re-run creates nothing", async () => {
  const p = await seed(); const fake = fakeProviders(); const store = new PrismaStore(db);
  await runProvision(p.id, steps(p, fake), { store });
  const res = await db.resource.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(res.map((r) => `${r.provider}/${r.kind}`), ["github/repo", "coolify/project"]);
  const st = await db.provisionStep.findMany({ where: { projectId: p.id } });
  assert.ok(st.length === 2 && st.every((s) => s.status === "done" && s.externalId && s.attempts === 1));
  const posts = fake.creates().length;
  const out = await runProvision(p.id, steps(p, fake), { store });
  assert.deepEqual(out.map((o) => o.outcome), ["recorded", "recorded"]);
  assert.equal(fake.creates().length, posts);
  assert.equal(await db.resource.count({ where: { projectId: p.id } }), 2);
});

test("AT3 on Postgres: a pending step (crash after create) is adopted on re-run, no second create", async () => {
  const p = await seed(); const fake = fakeProviders(); const store = new PrismaStore(db);
  const crashing = Object.create(store);
  crashing.recordResource = async () => { throw new Error("process killed"); };
  await assert.rejects(runProvision(p.id, steps(p, fake), { store: crashing }), /process killed/);
  const s = await db.provisionStep.findUnique({ where: { projectId_key: { projectId: p.id, key: "github/repo" } } });
  assert.equal(s.status, "pending");
  const out = await runProvision(p.id, steps(p, fake), { store });
  assert.deepEqual(out.map((o) => o.outcome), ["adopted", "created"]);
  assert.equal(fake.creates().filter((c) => c.path === "/user/repos").length, 1);
});

test("AT8 on Postgres: two concurrent runs serialize on the advisory lock; each resource is created once", async () => {
  const p = await seed(); const fake = fakeProviders();
  const [a, b] = await Promise.all([
    runProvision(p.id, steps(p, fake), { store: new PrismaStore(db) }),
    runProvision(p.id, steps(p, fake), { store: new PrismaStore(db) }),
  ]);
  const outcomes = [a, b].map((r) => r.map((o) => o.outcome).join(",")).sort();
  assert.deepEqual(outcomes, ["created,created", "recorded,recorded"]);
  assert.equal(fake.creates().filter((c) => c.path === "/user/repos").length, 1);
  assert.equal(fake.creates().filter((c) => c.path === "/api/v1/projects").length, 1);
});

test("Inventory: a row owned by another project is refused; a soft-deleted own row is reactivated", async () => {
  const p = await seed(); const q = await seed(); const store = new PrismaStore(db);
  const ext = `kkarnati1980/devos-${p.slug}`;
  await store.recordResource(p.id, { provider: "github", kind: "repo", externalId: ext, name: ext });
  await assert.rejects(store.recordResource(q.id, { provider: "github", kind: "repo", externalId: ext, name: ext }), /resource_owned_elsewhere/);
  await db.resource.update({ where: { provider_kind_externalId: { provider: "github", kind: "repo", externalId: ext } }, data: { status: "deleted", deletedAt: new Date() } });
  await store.recordResource(p.id, { provider: "github", kind: "repo", externalId: ext, name: ext });
  const r = await db.resource.findUnique({ where: { provider_kind_externalId: { provider: "github", kind: "repo", externalId: ext } } });
  assert.equal(r.status, "active");
});

test("DB checks: a done step needs an external id; last_error is bounded", async () => {
  const p = await seed();
  await assert.rejects(db.provisionStep.create({ data: { projectId: p.id, key: "x", provider: "github", kind: "repo", status: "done" } }));
  await assert.rejects(db.provisionStep.create({ data: { projectId: p.id, key: "y", provider: "github", kind: "repo", lastError: "e".repeat(301) } }));
});
