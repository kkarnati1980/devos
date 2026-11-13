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

  // Database checks refuse what the state document would refuse, even when written around the store. Each row breaks
  // exactly one check, and the rejection must name that check (pre-review).
  const row = (o) => {
    const slug = o.slug ?? b.slug, env = o.env ?? "preview", idx = o.idx;
    return { projectId: b.id, slug, env, idx, network: o.network ?? `devos-p-${slug}-${env}`, subnet: o.subnet ?? subnet(idx) };
  };
  const refusedBy = (check) => (e) => String(e?.message ?? "").includes(check);
  await assert.rejects(db.isolationStack.create({ data: row({ env: "production", idx: base + 2 }) }), refusedBy("isolation_stack_env_valid"));
  await assert.rejects(db.isolationStack.create({ data: row({ idx: 1024 }) }), refusedBy("isolation_stack_idx_range"));
  await assert.rejects(db.isolationStack.create({ data: row({ slug: "bad_slug", idx: base + 4 }) }), refusedBy("isolation_stack_slug_valid"));
  await assert.rejects(db.isolationStack.create({ data: row({ idx: base + 3, subnet: "10.208.0.0/16" }) }), refusedBy("isolation_stack_subnet_derived"));
  await assert.rejects(db.isolationStack.create({ data: row({ idx: base + 5, network: "devos-p-other-preview" }) }), refusedBy("isolation_stack_network_derived"));
  assert.equal(await db.isolationStack.count({ where: { projectId: b.id } }), 0);

  await db.isolationStack.deleteMany({ where: { projectId: { in: [a.id, b.id] } } });
});
