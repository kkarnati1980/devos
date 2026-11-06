// M1.4 AT14: the Prisma settings and vault stores against real Postgres (api-db workflow), with the
// M1.1 constraints and the M1.4 migration applied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaSettingsStore } from "../dist/settings.js";
import { PrismaVaultStore, Vault } from "../dist/vault.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

test("M1.4 AT14a: settings singleton is created, edited and audited; project cap and lanes; archived refused", async () => {
  const store = new PrismaSettingsStore(db, 3000);
  const before = await store.get();
  assert.equal(before.deadlockAttempts, 3);
  const t = new Date();
  const saved = await store.update({ anthropicCapUsd: "15.00", openaiCapUsd: "20.50", defaultProjectCapUsd: "15.00", deadlockAttempts: 3 }, t);
  assert.equal(saved.openaiCapUsd, "20.50");
  assert.equal(saved.capsConfirmedAt, t.toISOString());
  const again = await store.update({ defaultLanes: 3 }, t);
  assert.equal(again.defaultLanes, 3);
  assert.equal(again.openaiCapUsd, "20.50");
  assert.equal(await db.appSettings.count(), 1);
  await assert.rejects(store.update({ deadlockAttempts: 6 }, t)); // database check 1–5

  const slug = `m14-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug } });
  assert.deepEqual(await store.updateProject(p.id, { capUsd: "25.00", lanes: 3 }), { id: p.id, slug, capUsd: "25.00", lanes: 3 });
  await db.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  assert.equal(await store.updateProject(p.id, { lanes: 1 }), "archived");
  assert.equal(await store.updateProject("00000000-0000-4000-8000-000000000000", { lanes: 1 }), "not-found");

  await store.audit("settings.updated", "Settings saved", { fields: ["openaiCapUsd"] });
  const ev = await db.auditEvent.findFirst({ where: { action: "settings.updated" }, orderBy: { occurredAt: "desc" } });
  assert.equal(ev.actor, "kk");
  assert.deepEqual(ev.details, { fields: ["openaiCapUsd"] });
});

test("M1.4 AT14b: global secrets are saved and rotated in place, with the hint column; plaintext never stored", async () => {
  const vault = new Vault(new PrismaVaultStore(db, 3000), randomBytes(32), 1);
  const v1 = `TESTONLY-${randomBytes(16).toString("hex")}`;
  const v2 = `TESTONLY-${randomBytes(16).toString("hex")}`;
  const first = await vault.put("linear_api_key", v1);
  assert.equal(first.rotated, false);
  const second = await vault.put("linear_api_key", v2);
  assert.equal(second.rotated, true);
  assert.equal(second.meta.hint, v2.slice(-4));
  assert.equal(await vault.reveal("linear_api_key"), v2);
  const rows = await db.vaultSecret.findMany({ where: { projectId: null, name: "linear_api_key" } });
  assert.equal(rows.length, 1);
  assert.ok(!Buffer.from(rows[0].ciphertext).includes(Buffer.from(v2)));
  const list = await vault.list();
  assert.equal(list.find((m) => m.name === "linear_api_key").set, true);
  await assert.rejects(db.vaultSecret.update({ where: { id: rows[0].id }, data: { hint: "toolong" } })); // check: 4 chars
});
