// SM-12 add-on tests (docs/modules/S3.md, "S3-c6 SM-12 build notes").
// SM-12-L1: each paid service is declared with a monthly cap, and its usage appears in the project budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paidServices, costMeter, memoryStore, pgStore, monthOf, CapExceededError, PAID_USAGE_SQL } from "../src/cost.mjs";

const NOV = Date.parse("2026-11-16T10:00:00Z");
const services = () => paidServices([
  { name: "openai", unit: "usd-cents", monthlyCap: 1000 },
  { name: "transcribe", unit: "minutes", monthlyCap: 60 },
]);

test("SM-12-L1: each paid service is declared with its own monthly cap; there is no default", () => {
  const s = services();
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s[0]));
  assert.throws(() => paidServices([{ name: "openai", unit: "usd-cents" }]), /monthlyCap \(no default\)/);
  for (const cap of [0, -5, 1.5, "100", Number.NaN, 2 ** 60]) {
    assert.throws(() => paidServices([{ name: "openai", unit: "usd-cents", monthlyCap: cap }]), /monthlyCap/, String(cap));
  }
  assert.throws(() => paidServices([]), /at least one/);
  assert.throws(() => paidServices([{ name: "a", unit: "u", monthlyCap: 1 }, { name: "a", unit: "u", monthlyCap: 1 }]), /declared twice/);
  assert.throws(() => paidServices([{ name: "a", unit: "u", monthlyCap: 1, cap: 2 }]), /unknown field "cap"/);
  assert.throws(() => paidServices([{ name: "Open AI", unit: "u", monthlyCap: 1 }]), /service name/);
  assert.throws(() => paidServices([{ name: "a", unit: "US $", monthlyCap: 1 }]), /unit/);
  assert.throws(() => costMeter({ services: [{ name: "a", unit: "u", monthlyCap: 1 }] }), /paidServices\(\)/);
  assert.throws(() => costMeter({ services: s, timeZone: "Mars/Olympus" }), RangeError);
});

test("SM-12-L1: a paid call is refused before it runs when it would pass the cap, and its real cost is recorded", async () => {
  const meter = costMeter({ services: services(), now: () => NOV });
  let calls = 0;
  const paid = (cost) => async () => { calls += 1; return { cost, text: "ok" }; };
  assert.deepEqual(await meter.charge("openai", 300, paid(250)), { cost: 250, text: "ok" });
  await meter.charge("openai", 300, paid(400)); // cost more than estimated: the real cost is recorded
  assert.deepEqual((await meter.report()).services[0], { service: "openai", unit: "usd-cents", monthlyCap: 1000, spent: 650, remaining: 350 });

  const err = await meter.charge("openai", 351, paid(1)).catch((e) => e);
  assert.ok(err instanceof CapExceededError);
  assert.equal(err.code, "cap-exceeded");
  assert.equal(err.status, 429);
  assert.deepEqual([err.service, err.month, err.spent, err.estimate, err.cap], ["openai", "2026-11", 650, 351, 1000]);
  assert.equal(calls, 2, "the refused call never ran, so it spent nothing");
  await meter.charge("openai", 350, paid(350)); // exactly up to the cap is allowed
  await assert.rejects(meter.charge("openai", 1, paid(1)), CapExceededError);
  await meter.charge("openai", 0, async () => ({ text: "free" })); // a zero estimate always fits
  assert.equal(calls, 3);

  // Services are counted apart; a failed call keeps its reservation (it may have been billed).
  await assert.rejects(meter.charge("transcribe", 10, async () => { throw new Error("provider 502"); }), /provider 502/);
  const r = await meter.report();
  assert.deepEqual(r.month, "2026-11");
  assert.deepEqual(r.services.map((x) => [x.service, x.spent, x.remaining]), [["openai", 1000, 0], ["transcribe", 10, 50]]);

  await assert.rejects(meter.charge("dalle", 1, paid(1)), /undeclared paid service "dalle"/);
  for (const bad of [-1, 1.5, "10", Number.MAX_SAFE_INTEGER]) await assert.rejects(meter.charge("transcribe", bad, paid(1)), TypeError, String(bad));
  await assert.rejects(meter.charge("transcribe", 1), /needs a function/);
  await assert.rejects(meter.charge("transcribe", 1, async () => ({ cost: -3 })), /reported cost/);
});

test("SM-12-L1: the budget month turns over in the declared time zone, and concurrent charges never pass the cap", async () => {
  assert.equal(monthOf(Date.parse("2026-11-30T19:00:00Z")), "2026-11");
  assert.equal(monthOf(Date.parse("2026-11-30T19:00:00Z"), "Asia/Kolkata"), "2026-12");
  let t = Date.parse("2026-11-30T18:00:00Z");
  const meter = costMeter({ services: services(), now: () => t, timeZone: "Asia/Kolkata" });
  await meter.charge("transcribe", 60, async () => ({ cost: 60 }));
  await assert.rejects(meter.charge("transcribe", 1, async () => ({ cost: 1 })), CapExceededError);
  t = Date.parse("2026-11-30T18:30:00Z"); // midnight IST: a new month and a fresh cap
  assert.equal((await meter.report()).month, "2026-12");
  await meter.charge("transcribe", 1, async () => ({ cost: 1 }));

  const many = costMeter({ services: services(), now: () => NOV });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => many.charge("transcribe", 7, async () => ({ cost: 7 }))));
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 8, "8 × 7 = 56 fits under 60; the rest are refused");
  assert.equal((await many.report()).services[1].spent, 56);
});

// A small emulation of pgStore's statements, matched as exact text; it applies the conditional UPDATE the way Postgres
// does (the condition is checked on the newest row). The app's own test runs pgStore on its real database.
function fakePg() {
  const rows = new Map();
  const k = (s, m) => `${s} ${m}`;
  const query = async (text, params) => {
    if (text === "INSERT INTO paid_usage (service, month) VALUES ($1, $2) ON CONFLICT (service, month) DO NOTHING") {
      if (!rows.has(k(...params))) rows.set(k(...params), 0);
      return { rows: [] };
    }
    if (text === "UPDATE paid_usage SET spent = spent + $3, updated_at = now() WHERE service = $1 AND month = $2 AND spent + $3 <= $4 RETURNING spent") {
      const [s, m, amount, cap] = params;
      const cur = rows.get(k(s, m));
      if (cur === undefined || cur + amount > cap) return { rows: [] };
      rows.set(k(s, m), cur + amount);
      return { rows: [{ spent: String(cur + amount) }] }; // bigint arrives as a string from pg
    }
    if (text === "SELECT spent FROM paid_usage WHERE service = $1 AND month = $2") {
      const cur = rows.get(k(...params));
      return { rows: cur === undefined ? [] : [{ spent: String(cur) }] };
    }
    if (text === "UPDATE paid_usage SET spent = GREATEST(0, spent + $3), updated_at = now() WHERE service = $1 AND month = $2 RETURNING spent") {
      const [s, m, d] = params;
      rows.set(k(s, m), Math.max(0, rows.get(k(s, m)) + d));
      return { rows: [{ spent: String(rows.get(k(s, m))) }] };
    }
    if (text === "SELECT service, spent FROM paid_usage WHERE month = $1") {
      return { rows: [...rows].filter(([key]) => key.endsWith(` ${params[0]}`)).map(([key, v]) => ({ service: key.split(" ")[0], spent: String(v) })) };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { query, rows };
}

test("SM-12-L1: pgStore keeps the spend in paid_usage, so every instance counts against the same cap", async () => {
  const db = fakePg();
  const a = costMeter({ services: services(), store: pgStore(db.query), now: () => NOV });
  const b = costMeter({ services: services(), store: pgStore(db.query), now: () => NOV });
  await a.charge("openai", 600, async () => ({ cost: 500 }));
  await assert.rejects(b.charge("openai", 501, async () => ({ cost: 1 })), (e) => e instanceof CapExceededError && e.spent === 500);
  await b.charge("openai", 500, async () => ({ cost: 500 }));
  assert.deepEqual((await a.report()).services.map((x) => [x.service, x.spent]), [["openai", 1000], ["transcribe", 0]]);
  assert.equal(db.rows.get("openai 2026-11"), 1000);
  assert.match(PAID_USAGE_SQL, /PRIMARY KEY \(service, month\)/);
  assert.match(PAID_USAGE_SQL, /CHECK \(spent >= 0\)/);
  await assert.rejects(pgStore(async () => ({})).read("2026-11"), /must return \{ rows \}/);
  assert.throws(() => pgStore(null), /query function/);
  assert.throws(() => costMeter({ services: services(), store: {} }), /store.reserve/);
});
