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
  const audit = { action: "settings.updated", summary: "Settings saved", details: { fields: ["openaiCapUsd"] } };
  const saved = await store.update({ anthropicCapUsd: "15.00", openaiCapUsd: "20.50", defaultProjectCapUsd: "15.00", deadlockAttempts: 3 }, t, audit);
  assert.equal(saved.openaiCapUsd, "20.50");
  assert.equal(saved.capsConfirmedAt, t.toISOString());
  const again = await store.update({ defaultLanes: 3 }, t, audit);
  assert.equal(again.defaultLanes, 3);
  assert.equal(again.openaiCapUsd, "20.50");
  assert.equal(await db.appSettings.count(), 1);
  const audits = await db.auditEvent.count({ where: { action: "settings.updated" } });
  await assert.rejects(store.update({ deadlockAttempts: 6 }, t, audit)); // database check 1–5
  assert.equal(await db.auditEvent.count({ where: { action: "settings.updated" } }), audits, "a refused change leaves no audit row");

  const slug = `m14-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug } });
  const pa = { action: "project.settings.updated", summary: "Project settings saved", details: { fields: ["capUsd", "lanes"] }, projectId: p.id };
  assert.deepEqual(await store.updateProject(p.id, { capUsd: "25.00", lanes: 3 }, pa), { id: p.id, slug, capUsd: "25.00", lanes: 3 });
  assert.equal(await db.auditEvent.count({ where: { projectId: p.id, action: "project.settings.updated" } }), 1);
  await db.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  assert.equal(await store.updateProject(p.id, { lanes: 1 }, pa), "archived");
  assert.equal(await store.updateProject("00000000-0000-4000-8000-000000000000", { lanes: 1 }, pa), "not-found");

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
  const vaultEvents = await db.auditEvent.findMany({ where: { action: { in: ["vault.secret.saved", "vault.secret.rotated"] } }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(vaultEvents.slice(-2).map((e) => e.action), ["vault.secret.saved", "vault.secret.rotated"]);
  assert.ok(!JSON.stringify(vaultEvents).includes(v2));
  assert.equal(second.meta.hint, v2.slice(-4));
  assert.equal(await vault.reveal("linear_api_key"), v2);
  const rows = await db.vaultSecret.findMany({ where: { projectId: null, name: "linear_api_key" } });
  assert.equal(rows.length, 1);
  assert.ok(!Buffer.from(rows[0].ciphertext).includes(Buffer.from(v2)));
  const list = await vault.list();
  assert.equal(list.find((m) => m.name === "linear_api_key").set, true);
  await assert.rejects(db.vaultSecret.update({ where: { id: rows[0].id }, data: { hint: "toolong" } })); // check: 4 chars
});

test("M2.4-c2b: project app secrets are one row per (project, name), rotated in place, audited under the project", async () => {
  const vault = new Vault(new PrismaVaultStore(db, 3000), randomBytes(32), 1);
  const slug = `c2b-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug } });
  const q = await db.project.create({ data: { slug: `${slug}-q`, name: `${slug}-q` } });
  const v1 = randomBytes(32).toString("base64url");
  const v2 = randomBytes(32).toString("base64url");
  assert.equal(await vault.hasProject(p.id, "preview/SESSION_SECRET"), false);
  assert.deepEqual(await vault.putProject(p.id, "preview/SESSION_SECRET", v1), { rotated: false });
  assert.deepEqual(await vault.putProject(p.id, "preview/SESSION_SECRET", v2), { rotated: true });
  assert.equal(await vault.hasProject(p.id, "preview/SESSION_SECRET"), true);
  assert.equal(await vault.hasProject(q.id, "preview/SESSION_SECRET"), false);
  const rows = await db.vaultSecret.findMany({ where: { projectId: p.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hint, null);
  assert.ok(!Buffer.from(rows[0].ciphertext).includes(Buffer.from(v2)));
  assert.equal(await db.vaultSecret.count({ where: { projectId: null, name: "preview/SESSION_SECRET" } }), 0, "no global row");
  const ev = await db.auditEvent.findMany({ where: { projectId: p.id, action: { startsWith: "vault.app_secret." } }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(ev.map((e) => e.action), ["vault.app_secret.saved", "vault.app_secret.rotated"]);
  assert.ok(!JSON.stringify(ev).includes(v1) && !JSON.stringify(ev).includes(v2));
  // Two concurrent first puts leave one row (unique (project_id, name)).
  const n = "production/DB_PASSWORD";
  const both = await Promise.allSettled([vault.putProject(q.id, n, v1), vault.putProject(q.id, n, v2)]);
  assert.deepEqual(both.map((r) => r.status), ["fulfilled", "fulfilled"], "the native upsert never fails on the race");
  assert.equal(await db.vaultSecret.count({ where: { projectId: q.id, name: n } }), 1);
  await db.vaultSecret.deleteMany({ where: { projectId: { in: [p.id, q.id] } } });
});
