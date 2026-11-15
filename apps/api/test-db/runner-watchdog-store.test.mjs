// DEVOS-220 (docs/modules/runner-watchdog.md): PrismaWatchdogStore against real Postgres (api-db workflow), with the
// runner_watchdog_state migration applied. One row (id 1) survives a new store (a redeploy).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@devos/db";
import { EMPTY_STATE } from "../dist/runner-watchdog.js";
import { PrismaWatchdogStore } from "../dist/runner-watchdog-runtime.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for test:db");
const db = createDb(url);
after(() => db.$disconnect());

test("DEVOS-220: the watchdog state is one row, read back by a new store; an unknown stored shape reads as empty", async () => {
  await db.runnerWatchdogState.deleteMany({});
  const a = new PrismaWatchdogStore(db, 3000);
  assert.deepEqual(await a.load(), EMPTY_STATE, "no row yet");
  const s = { ...EMPTY_STATE, silentAlertAt: "2026-11-15T10:00:00.000Z", silentSince: "2026-11-15T08:00:00.000Z", lastRunAt: "2026-11-15T10:00:00.000Z" };
  await a.save(s);
  await a.save({ ...s, lastRunAt: "2026-11-15T10:30:00.000Z" });
  assert.equal(await db.runnerWatchdogState.count(), 1);
  const b = new PrismaWatchdogStore(db, 3000);
  assert.deepEqual(await b.load(), { ...s, lastRunAt: "2026-11-15T10:30:00.000Z" });
  await db.runnerWatchdogState.update({ where: { id: 1 }, data: { state: { silentAlertAt: 7, other: "x" } } });
  assert.deepEqual(await b.load(), EMPTY_STATE);
});
