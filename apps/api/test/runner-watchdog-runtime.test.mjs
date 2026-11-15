// DEVOS-220: runner watchdog runtime (contract docs/modules/runner-watchdog.md): Linear read, stored state, notifier,
// timer, heartbeat, and the AT6 log scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier, MemoryNotificationStore } from "../dist/notify.js";
import { TITLE_ACTIVE, TITLE_SILENT, EMPTY_STATE } from "../dist/runner-watchdog.js";
import {
  COMMENTS_PER_LOG, MemoryWatchdogStore, RUNNER_LOGS, RunnerWatchdogJob, observe, parseState, watchdogHeartbeat,
} from "../dist/runner-watchdog-runtime.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T10:00:00Z");
const FAKE_KEY = "sk-test-not-a-real-key-0000000000";

/** A fake LinearClient: `logs` maps an issue id to its comments, or to an Error to throw. */
function fakeLinear(logs) {
  const calls = [];
  return {
    calls,
    async query(q, v) {
      calls.push({ q, v });
      const x = logs[v.id];
      if (x instanceof Error) throw x;
      return x === undefined ? { issue: null } : { issue: { comments: { nodes: x } } };
    },
  };
}
const c = (t, body = "[runner-b] RUN END busy-min=30") => ({ createdAt: new Date(t).toISOString(), body });

test("observe reads both runner logs (read-only query) and takes the newest comment by time, in any order", async () => {
  const linear = fakeLinear({ "DEVOS-75": [c(T0 - 30 * MIN), c(T0 - 90 * MIN)], "DEVOS-89": [c(T0 - 200 * MIN), c(T0 - 10 * MIN, "B newest")] });
  const obs = await observe(linear, T0);
  assert.deepEqual(obs, { ok: true, newest: { at: new Date(T0 - 10 * MIN).toISOString(), body: "B newest" } });
  assert.deepEqual(linear.calls.map((x) => x.v), RUNNER_LOGS.map((id) => ({ id, n: COMMENTS_PER_LOG })));
  for (const { q } of linear.calls) {
    assert.match(q, /^query /);
    assert.doesNotMatch(q, /mutation/i);
  }
});

test("observe: a throw, a missing issue or a malformed reply is a failed read; bad or future times are handled", async () => {
  assert.deepEqual(await observe(fakeLinear({ "DEVOS-75": new Error("timeout"), "DEVOS-89": [c(T0)] }), T0), { ok: false });
  assert.deepEqual(await observe(fakeLinear({ "DEVOS-75": [c(T0)] }), T0), { ok: false }, "DEVOS-89 missing");
  const weird = { async query() { return { issue: { comments: { nodes: "nope" } } }; } };
  assert.deepEqual(await observe(weird, T0), { ok: false });
  const odd = await observe(fakeLinear({ "DEVOS-75": [{ createdAt: "x" }, null], "DEVOS-89": [c(T0 + 60 * MIN)] }), T0);
  assert.equal(odd.ok, true);
  assert.equal(odd.newest.at, new Date(T0).toISOString(), "a future time counts as now");
  assert.deepEqual(await observe(fakeLinear({ "DEVOS-75": [], "DEVOS-89": [] }), T0), { ok: true, newest: null });
});

test("parseState keeps only the known keys, as ISO times or null", () => {
  assert.deepEqual(parseState(null), EMPTY_STATE);
  const s = parseState({ silentAlertAt: "2026-11-15T10:00:00Z", capNoteAt: 5, extra: "x", lastRunAt: "garbage" });
  assert.equal(s.silentAlertAt, "2026-11-15T10:00:00.000Z");
  assert.equal(s.capNoteAt, null);
  assert.equal(s.lastRunAt, null);
  assert.equal("extra" in s, false);
});

function job({ logs, now, notify, store = new MemoryWatchdogStore() }) {
  const lines = [];
  const sent = [];
  const j = new RunnerWatchdogJob({
    linear: fakeLinear(logs),
    store,
    notify: notify ?? (async (n) => { sent.push(n); }),
    log: (e) => lines.push(JSON.stringify(e)),
    now: () => now.t,
  });
  return { j, lines, sent, store };
}

test("a tick sends the core's notices, then saves the state and the heartbeat; the next tick sends nothing new", async () => {
  const now = { t: T0 + 125 * MIN };
  const { j, sent, store } = job({ logs: { "DEVOS-75": [c(T0)], "DEVOS-89": [c(T0 - MIN)] }, now });
  assert.equal(await j.tick(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title.startsWith(TITLE_SILENT), true);
  assert.equal(store.state.silentAlertAt, new Date(now.t).toISOString());
  assert.equal(j.lastRunAt, new Date(now.t).toISOString());
  assert.equal(watchdogHeartbeat.lastRunAt, j.lastRunAt);
  now.t += 30 * MIN;
  assert.equal(await j.tick(), true);
  assert.equal(sent.length, 1, "6-hour limit holds across ticks through the store");
});

test("at most once (Codex PR139-r1): the state is saved before sending, a failed send is not retried, a failed save sends nothing", async () => {
  const now = { t: T0 + 125 * MIN };
  let calls = 0;
  const { j, store, lines } = job({ logs: { "DEVOS-75": [c(T0)], "DEVOS-89": [c(T0)] }, now, notify: async () => { calls++; throw new Error("notifications-store-error"); } });
  assert.equal(await j.tick(), true);
  assert.equal(calls, 1);
  assert.equal(store.state.silentAlertAt, new Date(now.t).toISOString(), "the alert is recorded before the send");
  assert.ok(lines.some((l) => l.includes("runner-watchdog-notify-failed") && l.includes("notifications-store-error")));
  now.t += 30 * MIN;
  await j.tick();
  assert.equal(calls, 1, "a send that may have delivered is never repeated by the next tick");

  // A store that cannot save sends nothing at all.
  const sent = [];
  const noSave = { load: async () => ({ ...EMPTY_STATE }), save: async () => { throw new Error("db down: postgres://user:pw@host"); } };
  const b = job({ logs: { "DEVOS-75": [c(T0)], "DEVOS-89": [c(T0)] }, now, store: noSave, notify: async (n) => { sent.push(n); } });
  assert.equal(await b.j.tick(), false);
  assert.deepEqual(sent, []);
  assert.ok(b.lines.some((l) => l.includes("runner-watchdog-state-save-failed")));

  // A store that cannot load skips the tick.
  const broken = { load: async () => { throw new Error("db down: postgres://user:pw@host"); }, save: async () => {} };
  const d = job({ logs: { "DEVOS-75": [c(T0)], "DEVOS-89": [c(T0)] }, now, store: broken });
  assert.equal(await d.j.tick(), false);
  assert.deepEqual(d.sent, []);
  assert.ok(d.lines.some((l) => l.includes("runner-watchdog-state-load-failed")));
  assert.equal([...b.lines, ...d.lines].join("\n").includes("postgres://"), false);
});

test("ticks never overlap", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = { async query() { await gate; return { issue: { comments: { nodes: [] } } }; } };
  const j = new RunnerWatchdogJob({ linear: slow, store: new MemoryWatchdogStore(), notify: async () => {}, log: () => {}, now: () => T0 });
  const first = j.tick();
  assert.equal(await j.tick(), false);
  release();
  assert.equal(await first, true);
});

test("recovery goes through the job too: one 'active again' after an alert", async () => {
  const now = { t: T0 + 125 * MIN };
  const logs = { "DEVOS-75": [c(T0)], "DEVOS-89": [c(T0)] };
  const { j, sent } = job({ logs, now });
  await j.tick();
  logs["DEVOS-89"] = [c(now.t + 5 * MIN)];
  now.t += 10 * MIN;
  await j.tick();
  assert.deepEqual(sent.map((n) => n.title.startsWith(TITLE_SILENT) ? "silent" : n.title), ["silent", TITLE_ACTIVE]);
});

test("AT6: through the real M1.6 Notifier, no key-shaped comment text reaches a notice, a delivery or a log line", async () => {
  const store = new MemoryNotificationStore();
  const notifier = new Notifier(store, { secrets: null, smtp: null, dashboardUrl: null, timeoutMs: 1000 });
  const now = { t: T0 + 125 * MIN };
  const ghFake = "ghp_" + "0".repeat(36);
  const body = `[runner-b] RUN END ${FAKE_KEY} ${ghFake} Bearer abc.def`;
  const logs = { "DEVOS-75": [c(T0, body)], "DEVOS-89": [c(T0 - MIN, body)] };
  const lines = [];
  const j = new RunnerWatchdogJob({ linear: fakeLinear(logs), store: new MemoryWatchdogStore(), notify: (n) => notifier.notify(n), log: (e) => lines.push(JSON.stringify(e)), now: () => now.t });
  assert.equal(await j.tick(), true);
  logs["DEVOS-75"] = new Error(`network error with ${FAKE_KEY}`);
  now.t += 30 * MIN;
  await j.tick();
  const feed = JSON.stringify(await store.feed?.(50) ?? store);
  const all = `${feed}\n${lines.join("\n")}`;
  for (const secret of [FAKE_KEY, ghFake, "Bearer abc"]) assert.equal(all.includes(secret), false, `leaked ${secret.slice(0, 6)}`);
  assert.ok(feed.includes("Build runners silent since"), "the notice was stored by the notifier");
});
