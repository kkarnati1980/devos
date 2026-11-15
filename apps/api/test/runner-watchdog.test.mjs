// DEVOS-219: runner watchdog core (contract docs/modules/runner-watchdog.md, AT1–AT6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNotice } from "../dist/notify.js";
import {
  EMPTY_STATE, SILENT_MS, TICK_MS, TITLE_ACTIVE, TITLE_CAP, TITLE_LINEAR, TITLE_SILENT, formatIst, isCapIdle, step,
} from "../dist/runner-watchdog.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-15T10:00:00Z"); // 15:30 IST
const iso = (t) => new Date(t).toISOString();
const seen = (t, body = "[runner-b] RUN END 2026-11-15T10:00:00Z (15:30 IST, 15 Nov 2026) busy-min=30") => ({ ok: true, newest: { at: iso(t), body } });
const CAP = "[runner] RUN END 2026-11-15T10:00:00Z (15:30 IST, 15 Nov 2026) idle: weekly cap reached (2600/2600)";

/** Runs steps in order from EMPTY_STATE; returns every step's notices and the last state. */
function run(steps) {
  let state = EMPTY_STATE;
  const out = [];
  for (const [obs, now] of steps) {
    const r = step(obs, state, now);
    // Every notice must pass M1.6's own validation, so Notifier.notify will accept it (DEVOS-220).
    for (const n of r.notices) assert.equal(typeof parseNotice(n), "object", `notice refused by parseNotice: ${n.title}`);
    out.push(r.notices);
    state = r.state;
  }
  return { out, state };
}

test("formatIst shows IST (UTC+5:30), day, month and year", () => {
  assert.equal(formatIst("2026-11-15T15:15:00Z"), "20:45 IST, 15 Nov 2026");
  assert.equal(formatIst("2026-11-14T20:00:00Z"), "01:30 IST, 15 Nov 2026");
});

test("AT1: a newest comment 2 h 05 m old gives exactly one silent alert; 30 minutes later, none", () => {
  const now = T0 + 125 * MIN;
  const { out, state } = run([[seen(T0), now], [seen(T0), now + TICK_MS]]);
  assert.equal(out[0].length, 1);
  assert.equal(out[0][0].title, `${TITLE_SILENT} 15:30 IST, 15 Nov 2026`);
  assert.equal(out[0][0].kind, "info");
  assert.match(out[0][0].body, /since 15:30 IST, 15 Nov 2026/);
  assert.match(out[0][0].body, /Settings → Billing \(payment and plan active\) and Settings → Connectors \(Linear connected\)/);
  assert.match(out[0][0].body, /reply to Claude in the AI Development Team chat/);
  assert.deepEqual(out[1], []);
  assert.equal(state.silentSince, iso(T0));
  assert.equal(state.lastRunAt, iso(now + TICK_MS));
});

test("AT1: the silent alert repeats only after 6 hours of continued silence", () => {
  const first = T0 + 125 * MIN;
  const steps = [];
  for (let t = first; t <= first + 6 * 60 * MIN; t += TICK_MS) steps.push([seen(T0), t]);
  const { out } = run(steps);
  const alerts = out.flat().filter((n) => n.title.startsWith(TITLE_SILENT));
  assert.equal(alerts.length, 2, "one at 2 h 05 m, one 6 h later");
  assert.equal(out.at(-1).length, 1, "the repeat lands exactly at the 6-hour mark");
  assert.equal(out.slice(1, -1).flat().length, 0);
});

test("AT2: a newest comment 1 h 50 m old gives no notice; exactly 2 h does", () => {
  assert.deepEqual(run([[seen(T0), T0 + 110 * MIN]]).out, [[]]);
  assert.equal(run([[seen(T0), T0 + SILENT_MS]]).out[0].length, 1);
});

test("AT3: a weekly-cap idle as the newest comment gives one cap note, not a silent alert, and none again within 24 h", () => {
  const start = T0 + 125 * MIN;
  const steps = [];
  for (let t = start; t < start + 24 * 60 * MIN; t += TICK_MS) steps.push([seen(T0, CAP), t]);
  steps.push([seen(T0, CAP), start + 24 * 60 * MIN]);
  const { out } = run(steps);
  const all = out.flat();
  assert.equal(all.filter((n) => n.title.startsWith(TITLE_SILENT)).length, 0);
  assert.equal(out[0].length, 1);
  assert.equal(out[0][0].title, TITLE_CAP);
  assert.match(out[0][0].body, /usage cap is reached/);
  assert.equal(all.filter((n) => n.title === TITLE_CAP).length, 2, "the second note comes only at the 24-hour mark");
  assert.equal(out.at(-1)[0].title, TITLE_CAP);
});

test("AT3: the cap prefix is read strictly (runner A, runner B, and nothing else)", () => {
  assert.equal(isCapIdle(CAP), true);
  assert.equal(isCapIdle("[runner-b] RUN END 2026-11-15T10:00:00Z (15:30 IST) idle: weekly cap reached (1500/1500)"), true);
  assert.equal(isCapIdle("[runner-b] RUN END 2026-11-15T10:00:00Z idle: nothing in my lanes"), false);
  assert.equal(isCapIdle("KK: please note the weekly cap reached idle: weekly cap reached"), false);
  assert.equal(isCapIdle("[runner-b] RUN START 2026-11-15T10:00:00Z idle: weekly cap reached"), false);
});

test("AT4: Linear failing for 2 hours gives one Linear-unreachable alert, none before, one per 6 hours", () => {
  const steps = [];
  for (let t = T0; t <= T0 + 8 * 60 * MIN; t += TICK_MS) steps.push([{ ok: false }, t]);
  const { out, state } = run(steps);
  const firstAlert = out.findIndex((n) => n.length > 0);
  assert.equal(firstAlert, 4, "the 5th failed read is the first at 2 h");
  assert.equal(out[firstAlert][0].title, TITLE_LINEAR);
  assert.match(out[firstAlert][0].body, /since 15:30 IST, 15 Nov 2026/);
  assert.equal(out.flat().length, 2, "a repeat only 6 hours after the first alert");
  assert.equal(out.flat().filter((n) => n.title.startsWith(TITLE_SILENT)).length, 0, "no silence judged while Linear cannot be read");
  assert.equal(state.linearFailingSince, iso(T0));
});

test("AT4: a good read clears the failure clock, so a later outage needs its own 2 hours", () => {
  const { out } = run([
    [{ ok: false }, T0],
    [{ ok: false }, T0 + 90 * MIN],
    [seen(T0 + 100 * MIN), T0 + 110 * MIN],
    [{ ok: false }, T0 + 120 * MIN],
    [{ ok: false }, T0 + 200 * MIN],
  ]);
  assert.equal(out.flat().length, 0);
});

test("AT5: after a silent alert, a newer comment gives exactly one 'active again', and a later silence alerts again", () => {
  const back = T0 + 200 * MIN;
  const { out, state } = run([
    [seen(T0), T0 + 125 * MIN],
    [seen(back), back + 5 * MIN],
    [seen(back), back + 35 * MIN],
    [seen(back), back + 125 * MIN],
  ]);
  assert.equal(out[0][0].title.startsWith(TITLE_SILENT), true);
  assert.equal(out[1].length, 1);
  assert.equal(out[1][0].title, TITLE_ACTIVE);
  assert.match(out[1][0].body, /again at 18:50 IST, 15 Nov 2026/);
  assert.deepEqual(out[2], []);
  assert.equal(out[3].length, 1);
  assert.equal(out[3][0].title.startsWith(TITLE_SILENT), true, "a new silence alerts at once, not after 6 h");
  assert.equal(state.silentSince, iso(back));
});

test("no comment at all judges nothing, and a malformed time never alerts", () => {
  assert.deepEqual(run([[{ ok: true, newest: null }, T0 + 10 * 60 * MIN]]).out, [[]]);
  assert.deepEqual(run([[{ ok: true, newest: { at: "not-a-time", body: "x" } }, T0]]).out, [[]]);
});

test("AT6: a comment body never reaches a notice, so a key-shaped body leaks nothing", () => {
  const fake = "sk-test-not-a-real-key-0000000000";
  const ghFake = "ghp_" + "0".repeat(36);
  const body = `[runner-b] RUN END 2026-11-15T10:00:00Z busy-min=30 ${fake} ${ghFake}`;
  const back = T0 + 200 * MIN;
  const { out } = run([[seen(T0, body), T0 + 125 * MIN], [seen(back, body), back + MIN], [{ ok: false }, back + 2 * MIN], [{ ok: false }, back + 200 * MIN]]);
  const text = JSON.stringify(out);
  assert.equal(out.flat().length, 3, "silent, active again, Linear unreachable");
  assert.equal(text.includes(fake), false);
  assert.equal(text.includes(ghFake), false);
  assert.equal(text.includes("busy-min"), false);
});
