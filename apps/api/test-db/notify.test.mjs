// M1.6 AT11: the Prisma notification store against real Postgres (api-db workflow), with the
// M1.6 migration applied: one row per channel, delivery outcomes, the feed, channel config + audit,
// and the database checks (notice shape, fixed error codes, one row per notice and channel).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@devos/db";
import { PrismaNotificationStore } from "../dist/notify.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

const notice = (over = {}) => ({
  id: randomUUID(),
  kind: "standard_selection",
  title: "Standard selection",
  body: "Selected: SM-02",
  reasons: ["upload input → B03"],
  projectId: null,
  approvalId: null,
  createdAt: new Date().toISOString(),
  ...over,
});

test("M1.6 AT11: notices, deliveries, feed and channel settings on Postgres", async () => {
  const store = new PrismaNotificationStore(db, 3000);
  const n = notice();
  await store.create(n, ["dashboard", "mybrain", "email"], new Date());
  await store.record(n.id, "mybrain", "sent", null, new Date());
  await store.record(n.id, "email", "failed", "email-timeout", new Date());
  const rows = await db.notification.findMany({ where: { noticeId: n.id }, orderBy: { channel: "asc" } });
  assert.deepEqual(
    rows.map((r) => [r.channel, r.status, r.attempts, r.error]),
    [["dashboard", "sent", 1, null], ["mybrain", "sent", 1, null], ["email", "failed", 1, "email-timeout"]],
  );
  const feed = await store.feed(50);
  const item = feed.find((f) => f.id === n.id);
  assert.ok(item);
  assert.deepEqual(item.reasons, n.reasons);
  assert.equal(item.deliveries.length, 3);

  // Database checks
  await assert.rejects(store.create(n, ["dashboard"], new Date()), "one row per notice and channel");
  await assert.rejects(store.create(notice({ kind: "spam" }), ["dashboard"], new Date()), "unknown kind refused");
  await assert.rejects(store.create(notice({ title: "x".repeat(121) }), ["dashboard"], new Date()), "long title refused");
  await assert.rejects(store.record(n.id, "email", "failed", "Upstream said: 550 user unknown", new Date()), "free-text error refused");
  // PR18-r1: a notice row without a kind, body or reasons array is refused (CHECK cannot pass on NULL).
  // Raw SQL, so the database check (not Prisma's input validation) is what refuses each row.
  for (const [kind, body, reasons] of [["NULL", "''", "'[]'"], ["'info'", "''", "NULL"], ["'info'", "NULL", "'[]'"], ["'info'", "''", `'{"not":"array"}'`]]) {
    await assert.rejects(
      db.$executeRawUnsafe(`INSERT INTO "notification" ("id", "notice_id", "kind", "title", "body", "reasons", "channel", "updated_at") VALUES (gen_random_uuid(), gen_random_uuid(), ${kind}, 't', ${body}, ${reasons}::jsonb, 'dashboard', now())`),
      `${kind} ${body} ${reasons}`,
    );
  }
  // The feed lists a notice that has no dashboard row (dashboard channel off).
  const quiet = notice();
  await store.create(quiet, ["email"], new Date());
  assert.ok((await store.feed(50)).some((f) => f.id === quiet.id && f.deliveries.length === 1));

  // Channel settings: upsert + audit in one transaction
  const before = await db.auditEvent.count({ where: { action: "notification.channel.updated" } });
  const saved = await store.setChannel("email", { target: "kk@example.com" }, { action: "notification.channel.updated", summary: "s", details: { channel: "email", fields: ["target"] } });
  assert.deepEqual(saved, { kind: "email", enabled: true, target: "kk@example.com" });
  const off = await store.setChannel("email", { enabled: false }, { action: "notification.channel.updated", summary: "s", details: { channel: "email", fields: ["enabled"] } });
  assert.deepEqual(off, { kind: "email", enabled: false, target: "kk@example.com" });
  assert.equal(await db.notificationChannel.count({ where: { kind: "email" } }), 1);
  assert.equal(await db.auditEvent.count({ where: { action: "notification.channel.updated" } }), before + 2);
  const chans = await store.channels();
  assert.deepEqual(chans.map((c) => c.kind), ["dashboard", "mybrain", "email"]);
  assert.equal(chans.find((c) => c.kind === "email").enabled, false);
});
