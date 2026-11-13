// S4-a2a (docs/modules/S4.md, "S4-a2 split"): the isolation_stack table and PrismaIsolationStore against real
// Postgres (api-db workflow), with the S4-a2a migration applied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaIsolationStore } from "../dist/isolation-store.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const subnet = (i) => `10.${208 + Math.floor(i / 256)}.${i % 256}.0/24`;
const rec = (p, env, idx) => ({ projectId: p.id, slug: p.slug, env, idx, network: `devos-p-${p.slug}-${env}`, subnet: subnet(idx) });

test("S4-a2a: one row per (project, env), idempotent; a taken index is refused and changes nothing; checks hold", async () => {
  const store = new PrismaIsolationStore(db, 3000);
  const mk = async () => { const slug = `s4a2a-${randomBytes(4).toString("hex")}`; return db.project.create({ data: { slug, name: slug } }); };
  const a = await mk();
  const b = await mk();
  const base = 900 + (randomBytes(1)[0] % 60);
  await store.recordStack(rec(a, "preview", base));
  await store.recordStack(rec(a, "preview", base));
  await store.recordStack(rec(a, "live", base + 1));
  assert.equal(await db.isolationStack.count({ where: { projectId: a.id } }), 2);

  await assert.rejects(store.recordStack(rec(b, "preview", base)), (e) => e.message === "isolation-index-taken");
  assert.equal(await db.isolationStack.count({ where: { projectId: b.id } }), 0, "a refused stack writes nothing");

  const listed = (await store.listStacks()).filter((r) => r.projectId === a.id);
  assert.deepEqual(listed, [
    { projectId: a.id, slug: a.slug, env: "preview", idx: base },
    { projectId: a.id, slug: a.slug, env: "live", idx: base + 1 },
  ]);

  // Database checks refuse what the state document would refuse, even when written around the store.
  const raw = { projectId: b.id, slug: b.slug, network: `devos-p-${b.slug}-preview` };
  await assert.rejects(db.isolationStack.create({ data: { ...raw, env: "production", idx: base + 2, subnet: subnet(base + 2) } }));
  await assert.rejects(db.isolationStack.create({ data: { ...raw, env: "preview", idx: 1024, subnet: "10.212.0.0/24" } }));
  await assert.rejects(db.isolationStack.create({ data: { ...raw, env: "preview", idx: base + 3, subnet: "192.168.0.0/24" } }));
  await assert.rejects(db.isolationStack.create({ data: { ...raw, slug: "Bad_Slug", env: "preview", idx: base + 4, subnet: subnet(base + 4) } }));
  assert.equal(await db.isolationStack.count({ where: { projectId: b.id } }), 0);

  await db.isolationStack.deleteMany({ where: { projectId: { in: [a.id, b.id] } } });
});
