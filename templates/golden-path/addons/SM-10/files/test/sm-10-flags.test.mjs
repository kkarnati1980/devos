// SM-10 add-on tests (docs/modules/S3.md, "S3-c4 SM-10 build notes").
// SM-10-L1: turning a phase's kill switch off hides its features without a redeploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { killSwitches, fileSource, dbSource, setKillSwitch, KILL_SWITCH_SQL } from "../src/flags.mjs";

const config = { server: { sha: "abc123", port: 0, host: "127.0.0.1" } };
const quiet = { write() {} };

async function serve(routes) {
  const app = createApp({ config, routes, out: quiet });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { base, close: () => new Promise((r) => app.close(r)) };
}
const ok = (body) => (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// A small emulation of the kill_switch table, matched as exact text. The app's own test runs it on its real database.
function fakeDb() {
  const rows = new Map();
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    if (text === "SELECT phase, enabled FROM kill_switch") return { rows: [...rows.values()].map(({ phase, enabled }) => ({ phase, enabled })) };
    if (text.startsWith("INSERT INTO kill_switch (phase, enabled, updated_at, updated_by) VALUES ($1, $2, now(), $3) ON CONFLICT (phase) DO UPDATE")) {
      const [phase, enabled, by] = params;
      rows.set(phase, { phase, enabled, updated_by: by });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return { query, rows, calls };
}

test("SM-10-L1: turning a phase off in the switch file hides its routes and UI flags, with no restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm10-"));
  const file = path.join(dir, "kill-switches.json");
  let t = 0;
  const switches = killSwitches({ phases: ["phase-1", "phase-2"], source: fileSource(file), refreshMs: 1000, now: () => t });
  const s = await serve({
    "GET /reports": switches.guard("phase-2", ok({ reports: [] })),
    "GET /notes": switches.guard("phase-1", ok({ notes: [] })),
    "GET /flags": async (_req, res) => ok(await switches.clientFlags())(_req, res),
  });
  try {
    // No file yet: every phase is at its default (on).
    assert.equal((await fetch(`${s.base}/reports`)).status, 200);
    assert.deepEqual(await (await fetch(`${s.base}/flags`)).json(), { "phase-1": true, "phase-2": true });

    // An operator turns phase 2 off. Inside refreshMs the old state still holds; after it, phase 2 is hidden.
    fs.writeFileSync(file, JSON.stringify({ "phase-2": false }));
    t = 999;
    assert.equal((await fetch(`${s.base}/reports`)).status, 200);
    t = 1000;
    // Requests never wait for the source: the first request after refreshMs still gets the old state and starts a
    // background re-read; once it lands, phase 2 is hidden.
    assert.equal((await fetch(`${s.base}/reports`)).status, 200);
    await switches.settled();
    const hidden = await fetch(`${s.base}/reports`);
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), { error: "not-found" }, "the same answer as a route that does not exist");
    assert.equal((await fetch(`${s.base}/nothing-here`)).status, 404);
    assert.equal((await fetch(`${s.base}/notes`)).status, 200, "other phases are untouched");
    assert.deepEqual(await (await fetch(`${s.base}/flags`)).json(), { "phase-1": true, "phase-2": false });
    assert.equal(switches.isOn("phase-2"), false);

    // Back on: the same running server shows it again.
    fs.writeFileSync(file, JSON.stringify({ "phase-2": true }));
    t = 2000;
    await switches.current();
    assert.equal((await fetch(`${s.base}/reports`)).status, 200);

    // Deleting a line returns that phase to its default (on), even after it was turned off.
    fs.writeFileSync(file, JSON.stringify({ "phase-1": false, "phase-2": false }));
    t = 3000;
    assert.deepEqual(await switches.current(), { "phase-1": false, "phase-2": false });
    fs.writeFileSync(file, JSON.stringify({ "phase-2": false }));
    t = 4000;
    assert.deepEqual(await switches.current(), { "phase-1": true, "phase-2": false });
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SM-10-L1: the kill_switch table turns a phase off and on through setKillSwitch, recording who did it", async () => {
  const db = fakeDb();
  let t = 0;
  const switches = killSwitches({ phases: ["phase-1", "phase-2"], source: dbSource(db.query), refreshMs: 500, now: () => t });
  const s = await serve({ "POST /reports": switches.guard("phase-2", ok({ created: true })) });
  try {
    assert.equal((await fetch(`${s.base}/reports`, { method: "POST" })).status, 200);
    await setKillSwitch(db.query, "phase-2", false, "ops@example.com");
    assert.deepEqual(db.rows.get("phase-2"), { phase: "phase-2", enabled: false, updated_by: "ops@example.com" });
    t = 500;
    await switches.current();
    assert.equal((await fetch(`${s.base}/reports`, { method: "POST" })).status, 404);
    await setKillSwitch(db.query, "phase-2", true, "ops@example.com");
    t = 1000;
    await fetch(`${s.base}/reports`, { method: "POST" }); // starts the background re-read
    await switches.settled();
    assert.equal((await fetch(`${s.base}/reports`, { method: "POST" })).status, 200);
  } finally {
    await s.close();
  }
  assert.match(KILL_SWITCH_SQL, /phase text PRIMARY KEY/);
  assert.match(KILL_SWITCH_SQL, /enabled boolean NOT NULL/);
  for (const [phase, enabled, by] of [["Phase 2", false, "ops"], ["phase-2", "false", "ops"], ["phase-2", false, ""], ["phase-2", false, "a b"]]) {
    await assert.rejects(setKillSwitch(db.query, phase, enabled, by), TypeError, JSON.stringify([phase, enabled, by]));
  }
  await assert.rejects(dbSource(async () => ({}))(), /must return \{ rows \}/);
});

test("SM-10-L1: a hung kill_switch query is never stacked, and requests do not wait for it", async () => {
  let calls = 0;
  let finish;
  const seen = [];
  // Called the node-postgres way: a third argument would be taken as a callback, so it must never be passed.
  const hung = async (...args) => { assert.equal(args.length, 2, "query(text, params) only"); calls += 1; if (calls === 1) return { rows: [] }; return new Promise((r) => { finish = () => r({ rows: [{ phase: "phase-2", enabled: false }] }); }); };
  const errors = [];
  let t = 0;
  const switches = killSwitches({ phases: ["phase-2"], source: dbSource(hung), refreshMs: 10, timeoutMs: 500, now: () => t, onError: (e) => errors.push(e.message) });
  const s = await serve({ "GET /reports": switches.guard("phase-2", ok({ reports: [] })) });
  try {
    assert.equal((await fetch(`${s.base}/reports`)).status, 200); // first read, awaited
    for (let i = 1; i <= 4; i += 1) {
      t = i * 10;
      const started = Date.now();
      assert.equal((await fetch(`${s.base}/reports`)).status, 200);
      assert.ok(Date.now() - started < 250, "a request does not wait for the hung read (timeoutMs is 500)");
      await switches.settled();
    }
    assert.equal(calls, 2, "one hung query, never a second one beside it");
    assert.ok(errors.some((m) => /did not answer within 500 ms/.test(m)));
    assert.ok(errors.some((m) => /previous source read still pending/.test(m)));
    finish(); // the query finally returns; its late result is ignored, and the next read runs again
    await new Promise((r) => setImmediate(r));
    t = 100;
    await switches.current();
    assert.equal(calls, 3);
  } finally {
    await s.close();
  }
});

test("SM-10-L1: a failing, hanging or malformed source keeps the last good state and is reported", async () => {
  const errors = [];
  let t = 0;
  let next;
  const switches = killSwitches({
    phases: ["phase-1", "phase-2"], defaults: { "phase-2": false }, refreshMs: 10, timeoutMs: 50, now: () => t,
    source: async ({ signal }) => next(signal), onError: (e) => errors.push(e.message),
  });
  // Before the first good read, defaults hold (a source that fails at start-up).
  next = () => { throw new Error("db down"); };
  assert.deepEqual(await switches.current(), { "phase-1": true, "phase-2": false });
  assert.deepEqual(errors, ["db down"]);

  next = () => ({ "phase-1": false, "phase-2": true });
  t = 10;
  assert.deepEqual(await switches.current(), { "phase-1": false, "phase-2": true });

  // Errors, a hang (cut at timeoutMs and aborted), a non-object and an array keep the last good state.
  let aborted = false;
  for (const bad of [
    () => { throw new Error("db down again"); },
    // A hang that honours its signal (a driver that cancels): it settles once aborted, so the next read may run.
    (signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }); }),
    () => "phase-1=false",
    () => [false, true],
    () => null,
  ]) {
    next = bad;
    t += 10;
    assert.deepEqual(await switches.current(), { "phase-1": false, "phase-2": true });
  }
  assert.ok(aborted, "a hung read is aborted");
  assert.ok(errors.some((m) => /did not answer within 50 ms/.test(m)));

  // A value that is not true/false keeps that phase's last good value; an unknown name is reported and not used.
  next = () => ({ "phase-1": "no", "phase-2": false, "phase-3": false });
  t += 10;
  assert.deepEqual(await switches.current(), { "phase-1": false, "phase-2": false });
  assert.ok(errors.some((m) => /"phase-1" is not true or false; kept false/.test(m)));
  assert.ok(errors.some((m) => /unknown phase in source: "phase-3"/.test(m)));
  const before = errors.length;
  t += 10;
  await switches.current();
  assert.equal(errors.filter((m) => /unknown phase/.test(m)).length, 1, "an unknown name is reported once, not on every read");
  assert.equal(errors.length, before + 1, "only the non-boolean value is reported again");

  // A file that is not JSON is an error too, and a throwing onError never breaks the app.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm10-"));
  try {
    const file = path.join(dir, "k.json");
    fs.writeFileSync(file, "{ phase-1: off");
    const loud = killSwitches({ phases: ["phase-1"], source: fileSource(file), onError: () => { throw new Error("boom"); } });
    assert.deepEqual(await loud.current(), { "phase-1": true });
    const rejected = [];
    const onRejection = (r) => rejected.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      const asyncLoud = killSwitches({ phases: ["phase-1"], source: fileSource(file), onError: async () => { throw new Error("reporter down"); } });
      assert.deepEqual(await asyncLoud.current(), { "phase-1": true });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    assert.deepEqual(rejected, [], "a rejecting async onError is swallowed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SM-10-L1: reads are shared and rate-limited; declarations are checked", async () => {
  let reads = 0;
  let release;
  let t = 0;
  const switches = killSwitches({ phases: ["phase-1"], refreshMs: 100, now: () => t, source: () => { reads += 1; return new Promise((r) => { release = () => r({ "phase-1": false }); }); } });
  const a = switches.current();
  const b = switches.current();
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await a, { "phase-1": false });
  assert.deepEqual(await b, { "phase-1": false });
  assert.equal(reads, 1, "concurrent callers share one read");
  t = 99;
  await switches.current();
  assert.equal(reads, 1, "no read inside refreshMs");
  assert.ok(Object.isFrozen(await switches.current()));

  assert.throws(() => switches.isOn("phase-9"), /unknown phase "phase-9"/);
  assert.throws(() => switches.guard("phase-9", () => {}), /unknown phase "phase-9"/);
  assert.throws(() => switches.guard("phase-1"), /needs a handler/);
  const src = () => ({});
  assert.throws(() => killSwitches({ phases: [], source: src }), /at least one phase/);
  assert.throws(() => killSwitches({ phases: ["phase-1", "phase-1"], source: src }), /declared twice/);
  assert.throws(() => killSwitches({ phases: ["Phase 1"], source: src }), /must match/);
  assert.throws(() => killSwitches({ phases: ["phase-1"] }), /source must be a function/);
  assert.throws(() => killSwitches({ phases: ["phase-1"], source: src, defaults: { "phase-2": false } }), /undeclared phase/);
  assert.throws(() => killSwitches({ phases: ["phase-1"], source: src, defaults: { "phase-1": "off" } }), /true or false/);
  assert.throws(() => killSwitches({ phases: ["phase-1"], source: src, refreshMs: -1 }), /refreshMs/);
  assert.throws(() => killSwitches({ phases: ["phase-1"], source: src, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => fileSource(""), /needs a path/);
  assert.throws(() => dbSource(null), /query function/);
});
