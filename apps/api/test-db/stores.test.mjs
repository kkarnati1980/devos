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
  // DEVOS-176 AT-CA9d: the migrated column, default off, round-trips on and off through the real store.
  assert.equal(again.analystModelPass, false);
  assert.equal((await store.update({ analystModelPass: true }, t, audit)).analystModelPass, true);
  assert.equal((await store.get()).analystModelPass, true);
  assert.equal((await store.update({ analystModelPass: false }, t, audit)).analystModelPass, false);
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

test("M2.4-c2b AT7: project app secrets upsert per (project, name) next to a same-named global row; audit names only", async () => {
  const vault = new Vault(new PrismaVaultStore(db, 3000), randomBytes(32), 1);
  const slug = `m24c2b-${randomBytes(6).toString("hex")}`;
  const p = await db.project.create({ data: { slug, name: slug } });
  const v1 = randomBytes(32).toString("base64url");
  const v2 = randomBytes(32).toString("base64url");
  assert.equal(await vault.hasProject(p.id, "preview/DB_PASSWORD"), false);
  assert.deepEqual(await vault.putProject(p.id, "preview/DB_PASSWORD", v1), { rotated: false });
  assert.deepEqual(await vault.putProject(p.id, "preview/DB_PASSWORD", v2), { rotated: true });
  assert.equal(await vault.hasProject(p.id, "preview/DB_PASSWORD"), true);
  assert.equal(await vault.matchesProject(p.id, "preview/DB_PASSWORD", v2), true);
  assert.equal(await vault.matchesProject(p.id, "preview/DB_PASSWORD", v1), false);
  const rows = await db.vaultSecret.findMany({ where: { projectId: p.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hint, null);
  assert.ok(!Buffer.from(rows[0].ciphertext).includes(Buffer.from(v2)));
  const audits = await db.auditEvent.findMany({ where: { projectId: p.id }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(audits.map((a) => a.action), ["vault.app_secret.saved", "vault.app_secret.rotated"]);
  assert.ok(!JSON.stringify(audits).includes(v1) && !JSON.stringify(audits).includes(v2));
  // The global trigger only guards project_id NULL rows: the same name may exist globally and per project.
  await db.vaultSecret.create({ data: { name: "preview/DB_PASSWORD", projectId: null, ciphertext: Buffer.alloc(32), nonce: Buffer.alloc(12), keyVersion: 1 } });
  assert.deepEqual(await vault.putProject(p.id, "preview/DB_PASSWORD", v1), { rotated: true });
  assert.equal(await db.vaultSecret.count({ where: { projectId: p.id } }), 1);
  await db.vaultSecret.deleteMany({ where: { name: "preview/DB_PASSWORD" } });
});
