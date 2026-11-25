// DEVOS-254 (M2.5-b4, docs/modules/M2.5.md "M2.5-b4 decisions"): one AT13 probe cycle purges through KK's purge card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStep, PROBE_CARD_MAX_MS, PROBE_CARD_PURGE_ROOM_MS, PROBE_CARD_RAISE_GRANT_MS, PROBE_CARD_START_GRANT_MS, PROBE_PHASE_MAX_MS, PROBE_SLUG } from "../dist/provision-probe.js";
import { CARD_GRANT_SHORT, archiveUnderProbeGrant, probeActiveCounts, probeCardCycle, probeCardOutcome, probeExistingCard, raiseProbePurgeCard, expireProbePurgeCards, PROBE_CARD_EXPIRE_REASON } from "../dist/provision-probe-purge.js";

const ROWS = [
  { key: "github_repo", provider: "github", externalId: "1", name: "devos-probe-m24" },
  { key: "coolify_project", provider: "coolify", externalId: "p-1", name: "devos-probe-m24" },
];
const DAY = 86_400_000;

/** A probe whose card is answered by `answer` (stage, card status) on each read. */
function fake(over = {}) {
  const log = [];
  const calls = { provision: 0, purge: 0, raise: 0, outcome: 0 };
  let t = Date.parse("2026-11-25T09:00:00Z");
  const state = { stage: "archived", card: "pending", decidedAt: null, proven: false, byCard: true };
  const d = {
    log, calls, state,
    fingerprint: "fp-1",
    now: () => new Date(t),
    tick: (ms) => { t += ms; },
    offReason: async () => null,
    last: async () => log.at(-1) ?? null,
    record: async (r) => { log.push(structuredClone(r)); },
    provisionOnce: async () => { calls.provision++; return "done"; },
    inventory: async () => ROWS,
    liveAsserts: async () => [],
    purge: async () => { calls.purge++; return "done"; },
    cardCycle: async () => !state.proven,
    raisePurgeCard: async () => { calls.raise++; return "card-1"; },
    // Codex PR239-r7: the probe grant's expiry; by default it outlasts any card wait.
    grantUntil: Infinity,
    expirePurgeCards: async () => { calls.expire = (calls.expire ?? 0) + 1; },
    cardGrantOutlasts: async (until) => { calls.grantCheck = (calls.grantCheck ?? 0) + 1; return until.getTime() < d.grantUntil; },
    cardOutcome: async (id) => { calls.outcome++; assert.equal(id, "card-1"); return { stage: state.stage, card: state.card, decidedAt: state.decidedAt, byCard: state.byCard, raisedAt: state.raisedAt }; },
    ...over,
  };
  return d;
}

/** Ticks until the phase is `phase` (or the cycle ends). */
async function until(d, phase, max = 20) {
  let r;
  for (let i = 0; i < max; i++) {
    r = await probeStep(d);
    if (r.phase === phase || r.exit !== 3) return r;
  }
  return r;
}

test("AT10: a card cycle raises KK's purge card after the asserts, waits, and passes once the sweep has purged", async () => {
  const d = fake();
  let r = await until(d, "cardwait");
  assert.deepEqual(d.log.map((x) => x.phase), ["run1", "inventory1", "run2", "inventory2", "assert", "card", "cardwait"]);
  assert.equal(d.log[0].viaCard, true);
  assert.equal(d.log.at(-1).cardId, "card-1");
  assert.equal(d.calls.raise, 1);
  // Pending: every tick waits, no purge, no second card.
  for (let i = 0; i < 3; i++) {
    d.tick(DAY);
    r = await probeStep(d);
    assert.deepEqual(r, { exit: 3, phase: "cardwait", cycle: 1, code: "in_progress", detail: "awaiting-card" });
  }
  // KK approves; the sweep is purging.
  d.state.card = "approved"; d.state.decidedAt = d.now().toISOString();
  r = await probeStep(d);
  assert.equal(r.detail, "card-approved");
  d.state.stage = "purged";
  r = await probeStep(d);
  assert.deepEqual(r, { exit: 0, phase: "done", cycle: 1, code: "pass-card", detail: undefined });
  assert.equal(d.calls.purge, 0, "the probe never purges a card cycle that KK approved");
  assert.equal(d.calls.raise, 1);
});

test("a cycle that is not a card cycle purges at once, as before, and never raises a card", async () => {
  const d = fake();
  d.state.proven = true;
  const r = await until(d, "done");
  assert.deepEqual(d.log.map((x) => x.phase), ["run1", "inventory1", "run2", "inventory2", "assert", "purge", "done"]);
  assert.equal(r.code, "pass");
  assert.equal(d.log[0].viaCard, undefined);
  assert.equal(d.calls.raise, 0);
  assert.equal(d.calls.outcome, 0);
});

test("without the card wiring a probe runs normal cycles (older deps)", async () => {
  const d = fake({ cardCycle: undefined, raisePurgeCard: undefined, cardOutcome: undefined });
  const r = await until(d, "done");
  assert.equal(r.code, "pass");
  assert.equal(d.log[0].viaCard, undefined);
});

test("Codex PR239-r7: a probe grant that would lapse during the card wait gives a normal cycle, purged at once", async () => {
  assert.ok(PROBE_CARD_RAISE_GRANT_MS >= PROBE_CARD_MAX_MS + 2 * PROBE_PHASE_MAX_MS, "room for the purge after the wait");
  assert.ok(PROBE_CARD_START_GRANT_MS > PROBE_CARD_RAISE_GRANT_MS, "room for the phases before the card");
  // Valid for the card wait itself, but not for the purge after it.
  const d = fake();
  d.grantUntil = d.now().getTime() + PROBE_CARD_MAX_MS + PROBE_PHASE_MAX_MS;
  const r = await until(d, "done");
  assert.equal(r.code, "pass");
  assert.equal(d.log[0].viaCard, undefined);
  assert.equal(d.calls.raise, 0, "no card KK could leave unanswered past the grant");
  assert.equal(d.calls.purge, 1, "purged at once under the still-valid grant");
  // A grant that outlasts the start horizon gives a card cycle.
  const ok = fake();
  ok.grantUntil = ok.now().getTime() + PROBE_CARD_START_GRANT_MS + 1;
  await until(ok, "cardwait");
  assert.equal(ok.log[0].viaCard, true);
  assert.equal(ok.calls.raise, 1);
  // A check that throws is a normal cycle too.
  const t = fake({ cardGrantOutlasts: async () => { throw new Error("db"); } });
  assert.equal((await until(t, "done")).code, "pass");
  assert.equal(t.calls.raise, 0);
  // Older deps without the check never start a card cycle.
  const o = fake({ cardGrantOutlasts: undefined });
  assert.equal((await until(o, "done")).code, "pass");
  assert.equal(o.calls.raise, 0);
});

test("Codex PR239-r7/r8: a card phase that raised no card for a short grant is purged by the probe with card-grant-short", async () => {
  const seen = [];
  const d = fake({ cardGrantOutlasts: async (u) => { seen.push(u.getTime() - d.now().getTime()); return true; } });
  await until(d, "card");
  assert.deepEqual(seen, [PROBE_CARD_START_GRANT_MS], "the start asks about the start horizon");
  d.raisePurgeCard = async () => CARD_GRANT_SHORT;
  let r = await probeStep(d);
  assert.deepEqual(r, { exit: 3, phase: "purge", cycle: 1, code: "in_progress" });
  assert.equal(d.log.at(-1).cardId, undefined);
  r = await until(d, "done");
  assert.equal(r.code, "card-grant-short");
  assert.equal(d.calls.purge, 1);
});

test("Codex PR239-r8: raiseProbePurgeCard checks the grant only before a new card, never when the archive has one", async () => {
  const AT = new Date("2026-11-25T09:00:00Z");
  const calls = { outlasts: 0, raise: 0, archive: 0 };
  const base = (over) => ({
    stage: async () => "archived", archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), expireStale: async () => {},
    archive: async () => { calls.archive++; }, raise: async () => { calls.raise++; return { id: "card-new", createdAt: AT }; },
    outlasts: async () => { calls.outlasts++; return false; }, ...over,
  });
  // A retried tick: this archive already has its card (pending, approved or purged): it is kept, the grant not asked.
  assert.equal(await raiseProbePurgeCard("p-1", base({ existing: async () => "card-1" })), "card-1");
  assert.equal(await raiseProbePurgeCard("p-1", base({ stage: async () => "purged", existing: async () => "card-1" })), "card-1");
  assert.deepEqual(calls, { outlasts: 0, raise: 0, archive: 0 });
  // No card yet and the grant too short: none raised.
  assert.equal(await raiseProbePurgeCard("p-1", base()), CARD_GRANT_SHORT);
  assert.deepEqual(calls, { outlasts: 1, raise: 0, archive: 0 });
  // A check that throws counts as too short.
  assert.equal(await raiseProbePurgeCard("p-1", base({ outlasts: async () => { calls.outlasts++; throw new Error("db"); } })), CARD_GRANT_SHORT);
  assert.equal(calls.raise, 0);
  // Long enough: the card is raised.
  assert.equal(await raiseProbePurgeCard("p-1", base({ outlasts: async () => true })), "card-new");
  assert.equal(calls.raise, 1);
});

test("a card-cycle read that throws is a normal cycle", async () => {
  const d = fake({ cardCycle: async () => { throw new Error("db"); } });
  const r = await until(d, "done");
  assert.equal(r.code, "pass");
  assert.equal(d.calls.raise, 0);
});

test("the first card cycle is due at once after a passed normal cycle; a failed card cycle waits the 7 days", async () => {
  const d = fake();
  d.state.proven = true;
  await until(d, "done");
  assert.equal((await probeStep(d)).code, "probed");
  d.state.proven = false; // the card wiring arrives with a deploy
  let r = await probeStep(d);
  assert.equal(r.phase, "run1");
  assert.equal(d.log.at(-1).viaCard, true);
  // KK rejects the card: the probe purges itself and the cycle fails.
  await until(d, "cardwait");
  d.state.card = "rejected";
  r = await probeStep(d);
  assert.equal(r.phase, "purge");
  r = await probeStep(d);
  assert.deepEqual(r, { exit: 1, phase: "done", cycle: 2, code: "card-rejected", detail: undefined });
  assert.equal(d.calls.purge, 2);
  // Not due again on the next check runs: no second card within the week.
  r = await probeStep(d);
  assert.equal(r.code, "probed");
  d.tick(7 * DAY);
  r = await probeStep(d);
  assert.equal(r.phase, "run1");
  assert.equal(d.log.at(-1).viaCard, true);
});

test("every card end other than a purge under an approved card is purged by the probe, with a fixed code", async () => {
  const cases = [
    [{ card: "expired" }, "card-expired", undefined],
    [{ card: "missing" }, "card-ended", "missing:archived"],
    [{ card: "pending", stage: "live" }, "card-ended", "pending:live"],
    [{ card: "pending", stage: "Bad Stage!" }, "card-ended", "pending:unknown"],
  ];
  for (const [s, code, detail] of cases) {
    const d = fake();
    await until(d, "cardwait");
    Object.assign(d.state, s);
    let r = await probeStep(d);
    assert.equal(r.phase, "purge", JSON.stringify(s));
    r = await probeStep(d);
    assert.deepEqual(r, { exit: 1, phase: "done", cycle: 1, code, detail }, JSON.stringify(s));
    assert.equal(d.calls.purge, 1);
  }
});

test("Codex PR239-r1: a purged row with an approved card but no purge proven under its grant is not AT10's proof", async () => {
  const d = fake();
  await until(d, "cardwait");
  d.state.stage = "purged"; d.state.card = "approved"; d.state.byCard = false;
  const r = await probeStep(d);
  assert.deepEqual(r, { exit: 1, phase: "done", cycle: 1, code: "card-unproven", detail: undefined });
  assert.equal(d.calls.purge, 0);
});

test("a purged row without an approved card is not AT10's proof", async () => {
  const d = fake();
  await until(d, "cardwait");
  d.state.stage = "purged"; d.state.card = "rejected";
  const r = await probeStep(d);
  assert.deepEqual(r, { exit: 1, phase: "done", cycle: 1, code: "card-ended", detail: "rejected:purged" });
});

test("an unanswered card ends after PROBE_CARD_MAX_MS; an approved purge that never finishes ends after PROBE_PHASE_MAX_MS", async () => {
  let d = fake();
  await until(d, "cardwait");
  d.tick(PROBE_CARD_MAX_MS - 1);
  assert.equal((await probeStep(d)).detail, "awaiting-card");
  d.tick(1);
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal((await probeStep(d)).code, "card-timeout");

  d = fake();
  await until(d, "cardwait");
  d.state.card = "approved"; d.state.decidedAt = d.now().toISOString();
  d.tick(PROBE_PHASE_MAX_MS - 1);
  assert.equal((await probeStep(d)).detail, "card-approved");
  d.tick(1);
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal((await probeStep(d)).code, "card-purge-unfinished");

  // An approval with no readable decision time is not waited for.
  d = fake();
  await until(d, "cardwait");
  d.state.card = "approved"; d.state.decidedAt = null;
  assert.equal((await probeStep(d)).phase, "purge");
});

test("Codex PR239-r12: the card wait runs from the card's raise when an earlier tick raised it, never from a later record", async () => {
  const d = fake();
  await until(d, "cardwait");
  // A tick raised the card 2 days before the tick that recorded `cardwait` (a retried tick reused it).
  const recorded = Date.parse(d.log.at(-1).at);
  d.state.raisedAt = new Date(recorded - 2 * 24 * 60 * 60 * 1000).toISOString();
  d.tick(PROBE_CARD_MAX_MS - 2 * 24 * 60 * 60 * 1000 - 1);
  assert.equal((await probeStep(d)).detail, "awaiting-card");
  d.tick(1);
  assert.equal((await probeStep(d)).phase, "purge", "the deadline is the card's raise + PROBE_CARD_MAX_MS");
  assert.equal((await probeStep(d)).code, "card-timeout");
  // A raise time after the record (clock skew) or an unreadable one never extends the wait past the record's deadline.
  for (const raisedAt of ["not-a-date", null]) {
    const e = fake();
    await until(e, "cardwait");
    e.state.raisedAt = raisedAt;
    e.tick(PROBE_CARD_MAX_MS - 1);
    assert.equal((await probeStep(e)).detail, "awaiting-card");
    e.tick(1);
    assert.equal((await probeStep(e)).phase, "purge");
  }
  const f = fake();
  await until(f, "cardwait");
  f.state.raisedAt = new Date(Date.parse(f.log.at(-1).at) + 24 * 60 * 60 * 1000).toISOString();
  f.tick(PROBE_CARD_MAX_MS);
  assert.equal((await probeStep(f)).phase, "purge");
});

test("Codex PR239-r13: a waiting tick ends with the probe's own purge once the grant would not outlast the next tick and the purge", async () => {
  const seen = [];
  const d = fake();
  await until(d, "cardwait");
  d.cardGrantOutlasts = async (u) => { seen.push(u.getTime() - d.now().getTime()); return u.getTime() < d.grantUntil; };
  d.grantUntil = d.now().getTime() + 3 * 24 * 60 * 60 * 1000;
  assert.equal((await probeStep(d)).detail, "awaiting-card");
  assert.deepEqual(seen, [PROBE_CARD_PURGE_ROOM_MS]);
  assert.equal(PROBE_CARD_PURGE_ROOM_MS, PROBE_CARD_RAISE_GRANT_MS - PROBE_CARD_MAX_MS);
  d.tick(2 * 24 * 60 * 60 * 1000);
  assert.equal((await probeStep(d)).phase, "purge", "the wait ends while the grant still covers the purge");
  assert.equal(d.log.at(-1).result.code, "card-grant-short");
  assert.equal(d.log.at(-1).result.detail, "awaiting-card");
  assert.equal((await probeStep(d)).code, "card-grant-short");
  // An unreadable card and an approved, still-purging card are held the same way; a check that throws ends the wait.
  for (const set of [(e) => { e.cardOutcome = async () => { throw new Error("db"); }; }, (e) => { e.state.card = "approved"; e.state.decidedAt = e.now().toISOString(); }]) {
    const e = fake();
    await until(e, "cardwait");
    set(e);
    e.cardGrantOutlasts = async () => { throw new Error("db"); };
    assert.equal((await probeStep(e)).phase, "purge");
    assert.equal(e.log.at(-1).result.code, "card-grant-short");
  }
  // A purged row is read before any grant check: AT10's pass needs no grant.
  const f = fake();
  await until(f, "cardwait");
  f.cardGrantOutlasts = async () => false;
  f.state.stage = "purged"; f.state.card = "approved"; f.state.byCard = true;
  assert.equal((await probeStep(f)).code, "pass-card");
});

test("a card read that throws waits, then times out; a failed raise or an empty id is purged by the probe", async () => {
  let d = fake();
  await until(d, "cardwait");
  d.cardOutcome = async () => { throw new Error("db"); };
  assert.equal((await probeStep(d)).detail, "card-unreadable");
  d.tick(PROBE_CARD_MAX_MS);
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal((await probeStep(d)).code, "card-timeout");

  d = fake({ raisePurgeCard: async () => "" });
  await until(d, "card");
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal((await probeStep(d)).code, "card-raise-failed");
  assert.equal(d.calls.purge, 1);
});

test("Codex PR239-r14: a raise that throws (perhaps after persisting the card) is retried in card, then tracked; purged only after the phase bound", async () => {
  let d = fake();
  await until(d, "card");
  const real = d.raisePurgeCard;
  let fails = 2;
  d.raisePurgeCard = async () => { if (fails-- > 0) { d.calls.raise++; throw new Error("db after insert"); } return real(); };
  for (let i = 0; i < 2; i++) {
    const r = await probeStep(d);
    assert.deepEqual([r.phase, r.detail], ["card", "card-raise-retry"]);
  }
  assert.equal(d.calls.purge, 0, "no fallback purge while the card may be pending");
  let r = await probeStep(d);
  assert.equal(r.phase, "cardwait");
  assert.equal(d.log.at(-1).cardId, "card-1");
  // Throwing for the whole phase bound: purged by the probe.
  d = fake({ raisePurgeCard: async () => { throw new Error("x"); } });
  await until(d, "card");
  d.tick(PROBE_PHASE_MAX_MS - 1);
  assert.equal((await probeStep(d)).detail, "card-raise-retry");
  d.tick(1);
  assert.equal((await probeStep(d)).phase, "purge");
  r = await probeStep(d);
  assert.equal(r.code, "card-raise-failed");
  assert.equal(d.calls.purge, 1);
});

test("a deploy that changes the fingerprint while KK's card waits does not end the cycle", async () => {
  const d = fake();
  await until(d, "cardwait");
  d.fingerprint = "fp-2";
  assert.equal((await probeStep(d)).detail, "awaiting-card");
  // Before the compare it still ends the cycle, as before.
  const e = fake();
  await probeStep(e);
  e.fingerprint = "fp-2";
  assert.equal((await probeStep(e)).phase, "purge");
});

test("raiseProbePurgeCard archives once, then raises the M2.5-b2 purge card unchanged with the counts", async () => {
  let stage = "live";
  const raised = [];
  const AT = new Date("2026-11-25T10:00:00Z"), LATER = new Date("2026-11-25T10:00:01Z"), EARLIER = new Date("2026-11-20T00:00:00Z");
  const id = await raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {},
    stage: async () => stage,
    archivedAt: async () => AT, existing: async () => null,
    existing: async () => null,
    archive: async () => { stage = "archived"; },
    counts: async () => ({ github: 1, coolify: 3 }),
    raise: async (c) => { raised.push(c); return { id: "card-9", createdAt: LATER }; },
  });
  assert.equal(id, "card-9");
  assert.equal(raised.length, 1);
  const c = raised[0];
  assert.equal(c.gate, "purge");
  assert.equal(c.action, "teardown.purge");
  assert.equal(c.target, "project:p-1");
  assert.equal(c.projectId, "p-1");
  assert.match(c.reason, new RegExp(`^Purge project ${PROBE_SLUG}\\?`));
  // Already archived (a retried tick): no second archive.
  let archived = 0;
  await raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "archived", archivedAt: async () => AT, existing: async () => null, archive: async () => { archived++; }, counts: async () => ({}), raise: async () => ({ id: "card-9", createdAt: AT }) });
  assert.equal(archived, 0);
  // An archive that did not reach `archived`, a purged row, or no id: no card is used.
  await assert.rejects(raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "live", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "x", createdAt: LATER }) }), /probe-card-not-archived/);
  await assert.rejects(raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "purged", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "x", createdAt: LATER }) }), /probe-card-already-purged/);
  await assert.rejects(raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "archived", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "", createdAt: LATER }) }), /probe-card-not-raised/);
  // Codex PR239-r12/r13: a Restore and a new Archive between the lookup and the raise: the card raised within the new
  // archive is the one tracked (bound to the archive read after the raise), never left pending behind a fallback.
  {
    const NEW = new Date("2026-11-25T11:00:00Z");
    const reads = [AT, NEW];
    const lookups = [];
    let raisedCards = 0;
    const got = await raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "archived", archivedAt: async () => reads.shift() ?? NEW, existing: async (since) => { lookups.push(since); return lookups.length === 2 ? "new" : null; }, archive: async () => {}, counts: async () => ({}), raise: async () => { raisedCards++; return { id: "new", createdAt: new Date("2026-11-25T11:00:01Z") }; } });
    assert.equal(got, "new");
    assert.equal(raisedCards, 1);
    assert.deepEqual(lookups, [AT, NEW], "the second lookup is against the archive read after the raise");
  }
  // Pre-review 2: a pending twin from an earlier archive (or one with no times) is never used.
  for (const [archivedAt, createdAt] of [[AT, EARLIER], [null, LATER], [AT, undefined]]) {
    await assert.rejects(raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {}, stage: async () => "archived", archivedAt: async () => archivedAt, existing: async () => null, archive: async () => {}, counts: async () => ({}), raise: async () => ({ id: "old", createdAt }) }), /probe-card-stale/);
  }
});

/** A fake db for the two bounded reads. */
const ARCHIVED = new Date("2026-11-25T09:00:00Z");
function db({ project = { stage: "archived", archivedAt: ARCHIVED }, approval = null, count = 0 } = {}) {
  const seen = {};
  const tx = {
    project: { findUnique: async (q) => { seen.project = q; return project; } },
    approval: { findUnique: async (q) => { seen.approval = q; return approval; }, findMany: async () => [] },
    auditEvent: { count: async (q) => { seen.count = q; return count; } },
  };
  return { seen, $transaction: async (fn, o) => { seen.opts = o; return fn(tx); } };
}

test("probeCardOutcome reads only this project's own purge card; probeCardCycle reads the probe's phase log", async () => {
  const at = new Date("2026-11-25T10:00:00Z");
  let x = db({ approval: { status: "approved", decidedAt: at, createdAt: at, projectId: "p-1", action: "teardown.purge" } });
  assert.deepEqual(await probeCardOutcome(x, "p-1", "c-1", 5000), { stage: "archived", card: "approved", decidedAt: at.toISOString(), raisedAt: at.toISOString(), byCard: false });
  assert.deepEqual(x.seen.approval.where, { id: "c-1" });
  assert.deepEqual(x.seen.opts, { timeout: 5000, maxWait: 5000 });
  for (const approval of [null, { status: "approved", projectId: "other", action: "teardown.purge" }, { status: "approved", projectId: "p-1", action: "teardown.probe-grant" }, { status: "weird", projectId: "p-1", action: "teardown.purge" }]) {
    x = db({ approval });
    assert.equal((await probeCardOutcome(x, "p-1", "c-1", 5000)).card, "missing", JSON.stringify(approval));
  }
  await assert.rejects(probeCardOutcome(db({ project: null }), "p-1", "c-1", 5000), /probe-project-missing/);

  x = db({ count: 0 });
  assert.equal(await probeCardCycle(x, "p-1", 5000), true);
  assert.deepEqual(x.seen.count.where, { projectId: "p-1", action: "provision.probe_phase", details: { path: ["result", "code"], equals: "pass-card" } });
  assert.equal(await probeCardCycle(db({ count: 1 }), "p-1", 5000), false);
});

test("pre-review 1: a failed cycle, card or not, is not due again before the 7 days (no purge on every check run)", async () => {
  // A cleanup cycle (purge-pending) whose purge fails: before b4 it waited 7 days, and it still does.
  const d = fake({ purge: async () => { d.calls.purge++; return { error: "purge-incomplete:leftover" }; } });
  d.log.push({ cycle: 1, phase: "done", at: d.now().toISOString(), fingerprint: "fp-1", result: { ok: false, code: "purge-failed", detail: "purge-incomplete:leftover" } });
  for (let i = 0; i < 8; i++) {
    d.tick(6 * 3_600_000);
    assert.equal((await probeStep(d)).code, "probed");
  }
  assert.equal(d.calls.purge, 0);
  assert.equal(d.calls.provision, 0);
});

test("pre-review 6: the card cycle's Archive asks for the probe grant on teardown.archive only, and needs one", async () => {
  const asked = [], used = [];
  await archiveUnderProbeGrant({ findGrant: async (a) => { asked.push(a); return "g-1"; }, archive: async (g) => { used.push(g); } });
  assert.deepEqual(asked, [["teardown.archive"]]);
  assert.deepEqual(used, ["g-1"]);
  await assert.rejects(archiveUnderProbeGrant({ findGrant: async () => null, archive: async () => { throw new Error("must not run"); } }), /probe-card-no-grant/);
});

test("pre-review 5: the card's counts are one bounded grouped count", async () => {
  const seen = {};
  const x = { $transaction: async (fn, o) => { seen.opts = o; return fn({ resource: { groupBy: async (q) => { seen.q = q; return [{ provider: "github", _count: { _all: 1 } }, { provider: "coolify", _count: { _all: 3 } }]; } } }); } };
  assert.deepEqual(await probeActiveCounts(x, "p-1", 5000), { github: 1, coolify: 3 });
  assert.deepEqual(seen.q, { by: ["provider"], where: { projectId: "p-1", status: "active" }, _count: { _all: true } });
  assert.deepEqual(seen.opts, { timeout: 5000, maxWait: 5000 });
});

test("Codex PR239-r1: a retried card tick uses the card this archive already has, whatever its status", async () => {
  const AT = new Date("2026-11-25T10:00:00Z");
  const sinceSeen = [];
  for (const stage of ["archived", "purged"]) {
    let raised = 0, archived = 0;
    const id = await raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {},
      stage: async () => stage, archivedAt: async () => AT,
      existing: async (since) => { sinceSeen.push(since); return "card-1"; },
      archive: async () => { archived++; }, counts: async () => ({}), raise: async () => { raised++; return { id: "card-2", createdAt: AT }; },
    });
    assert.equal(id, "card-1", stage);
    assert.equal(raised, 0);
    assert.equal(archived, 0);
  }
  assert.deepEqual(sinceSeen, [AT, AT]);
});

test("Codex PR239-r1: probeCardOutcome proves the purge ran under this card's grant, and probeExistingCard is bounded", async () => {
  const created = new Date("2026-11-25T10:00:00Z");
  const card = { status: "approved", decidedAt: created, createdAt: created, projectId: "p-1", action: "teardown.purge" };
  const run = async (decisions, approved = [{ id: "c-1", decidedAt: created }], archivedAt = new Date("2026-11-25T09:00:00Z")) => {
    const seen = {};
    const tx = {
      project: { findUnique: async () => ({ stage: "purged", archivedAt }) },
      approval: { findUnique: async () => card, findMany: async (q) => { seen.a = q; return approved; } },
      policyDecision: { findMany: async (q) => { seen.q = q; return decisions; } },
    };
    const out = await probeCardOutcome({ $transaction: async (fn) => fn(tx) }, "p-1", "c-1", 5000);
    return { out, seen };
  };
  const mine = { approvalGrant: { approvalId: "c-1" } };
  let r = await run([mine, mine]);
  assert.equal(r.out.byCard, true);
  assert.deepEqual(r.seen.q.where, { projectId: "p-1", ts: { gte: created }, enforcedOutcome: "allow", action: { path: ["request", "type"], equals: "teardown.purge" } });
  assert.equal(r.seen.q.take, 50);
  for (const ds of [[], [mine, { approvalGrant: { approvalId: "other" } }], [{ approvalGrant: null }], Array(50).fill(mine)]) {
    assert.equal((await run(ds)).out.byCard, false, JSON.stringify(ds).slice(0, 80));
  }
  // Codex PR239-r3: the sweep purges under the newest approved card of the archive, which may be a later twin.
  assert.deepEqual(r.seen.a.where, { projectId: "p-1", action: "teardown.purge", target: "project:p-1", status: "approved", createdAt: { gte: created } });
  assert.deepEqual(r.seen.a.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
  const later = new Date("2026-11-25T11:00:00Z");
  const twin = { approvalGrant: { approvalId: "c-2" } };
  r = await run([twin], [{ id: "c-2", decidedAt: later }, { id: "c-1", decidedAt: created }]);
  assert.deepEqual(r.out, { stage: "purged", card: "approved", decidedAt: later.toISOString(), raisedAt: created.toISOString(), byCard: true });
  // A grant for a card that is not an approved purge card of this archive never counts, and no approved card at all is
  // the tracked card's own status.
  assert.equal((await run([twin])).out.byCard, false);
  r = await run([mine], []);
  assert.equal(r.out.byCard, false);
  assert.equal(r.out.card, "approved");
  // Codex PR239-r6: after a Restore and a new Archive, the tracked card is older than the row's archived_at: it reads
  // as missing and nothing from the later archive counts, so the cycle can never end pass-card.
  r = await run([twin], [{ id: "c-2", decidedAt: later }], new Date("2026-11-25T10:30:00Z"));
  assert.deepEqual(r.out, { stage: "purged", card: "missing", decidedAt: null, raisedAt: null, byCard: false });
  r = await run([mine], undefined, null);
  assert.equal(r.out.card, "missing");
  const seen = {};
  const x = { $transaction: async (fn, o) => { seen.o = o; return fn({ approval: { findFirst: async (q) => { seen.q = q; return { id: "c-9" }; } } }); } };
  assert.equal(await probeExistingCard(x, "p-1", created, 5000), "c-9");
  assert.deepEqual(seen.q.where, { projectId: "p-1", action: "teardown.purge", target: "project:p-1", createdAt: { gte: created } });
  assert.deepEqual(seen.q.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(seen.o, { timeout: 5000, maxWait: 5000 });
  const none = { $transaction: async (fn) => fn({ approval: { findFirst: async () => null } }) };
  assert.equal(await probeExistingCard(none, "p-1", created, 5000), null);
});

test("Codex PR239-r2: a card raised by someone else between the lookup and the raise is the one tracked", async () => {
  const AT = new Date("2026-11-25T10:00:00Z"), LATER = new Date("2026-11-25T10:00:05Z");
  let reads = 0;
  const id = await raiseProbePurgeCard("p-1", { outlasts: async () => true, expireStale: async () => {},
    stage: async () => "archived", archivedAt: async () => AT,
    existing: async () => (reads++ === 0 ? null : "card-first"),
    archive: async () => {}, counts: async () => ({}), raise: async () => ({ id: "card-probe", createdAt: LATER }),
  });
  assert.equal(id, "card-first");
  assert.equal(reads, 2);
});

const HOUR = 3_600_000;

test("Codex PR239-r15: a card raise that throws across 6 h server checks leaves no pending card behind the probe's purge", async () => {
  // The production sequence: the raise persists KK's card, then throws; the next check runs 6 h later and throws again.
  const order = [];
  const d = fake({ purge: async () => { order.push("purge"); d.calls.purge++; return "done"; } });
  d.expirePurgeCards = async () => { order.push("expire"); };
  await until(d, "card");
  d.raisePurgeCard = async () => { throw new Error("db after insert"); };
  assert.equal((await probeStep(d)).detail, "card-raise-retry");
  d.tick(6 * HOUR);
  const r = await probeStep(d);
  assert.equal(r.phase, "purge");
  assert.equal(d.log.at(-1).expireCards, true, "the fallback purge is marked to expire the probe's cards first");
  d.tick(6 * HOUR);
  const end = await probeStep(d);
  assert.deepEqual([end.phase, end.code], ["done", "card-raise-failed"]);
  assert.deepEqual(order, ["expire", "purge", "expire"], "the pending card is expired before the probe purges (and once more after, r20)");
});

test("Codex PR239-r15: every way out of card and cardwait to the probe's purge expires the cards first; a normal cycle never does", async () => {
  for (const card of ["pending-timeout", "rejected", "expired", "grant-short"]) {
    const order = [];
    const d = fake({ purge: async () => { order.push("purge"); return "done"; } });
    d.expirePurgeCards = async () => { order.push("expire"); };
    await until(d, "cardwait");
    if (card === "pending-timeout") d.tick(PROBE_CARD_MAX_MS);
    else if (card === "grant-short") d.grantUntil = d.now().getTime();
    else d.state.card = card;
    assert.equal((await probeStep(d)).phase, "purge");
    assert.equal((await probeStep(d)).phase, "done");
    assert.deepEqual(order, ["expire", "purge", "expire"], card);
  }
  const n = fake();
  n.state.proven = true;
  await until(n, "done");
  assert.equal(n.calls.expire, undefined, "a normal cycle has no card to expire");
  // Without the expiry wired, no cycle is a card cycle.
  const w = fake({ expirePurgeCards: undefined });
  await until(w, "done");
  assert.equal(w.log[0].viaCard, undefined);
  assert.equal(w.calls.raise, 0);
});

test("Codex PR239-r15/r16: a failing expiry holds the purge while the grant lasts, then purges in that same tick with its own bound", async () => {
  let d = fake();
  let fail = true;
  d.expirePurgeCards = async () => { if (fail) throw new Error("db"); };
  await until(d, "cardwait");
  d.state.card = "rejected";
  await probeStep(d);
  d.grantUntil = d.now().getTime() + 3 * DAY;
  for (let i = 0; i < 4; i++) {
    d.tick(6 * HOUR);
    assert.equal((await probeStep(d)).detail, "card-expire-retry");
  }
  assert.equal(d.calls.purge, 0, "no purge past a card that may still be pending");
  // r16: the grant would no longer outlast the next tick and the purge, so the purge runs now, under the grant
  // that is still valid, never deferred to a later check.
  d.tick(DAY + 1);
  let r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["done", "card-rejected"]);
  assert.equal(d.calls.purge, 1);
  assert.equal(d.log.at(-1).cardExpireGaveUp, true);
  // Given up with a purge still in progress: one row restarts the bound from that tick.
  d = fake({ expirePurgeCards: async () => { throw new Error("db"); } });
  await until(d, "cardwait");
  d.state.card = "expired";
  await probeStep(d);
  d.cardGrantOutlasts = async () => { throw new Error("db"); };
  d.purge = async () => { d.calls.purge++; return "in_progress"; };
  d.tick(6 * HOUR);
  const rows = d.log.length;
  r = await probeStep(d);
  assert.deepEqual([r.phase, r.detail, d.calls.purge], ["purge", "card-expire-gave-up", 1], "a throwing grant check gives up at once and purges");
  assert.equal(d.log.length, rows + 1, "one row per call");
  assert.deepEqual([d.log.at(-1).at, d.log.at(-1).expireCards, d.log.at(-1).cardExpireGaveUp], [d.now().toISOString(), false, true]);
  d.tick(PROBE_PHASE_MAX_MS - 1);
  assert.equal((await probeStep(d)).phase, "purge", "the bound runs from the restart");
  d.tick(1);
  r = await probeStep(d);
  assert.deepEqual([r.phase, r.code, r.cause], ["done", "purge-failed", "card-expired"]);
  // r16: an expiry that succeeds after retries purges in that same tick, and the purge's bound runs from that tick.
  d = fake();
  fail = true;
  d.expirePurgeCards = async () => { d.calls.expire = (d.calls.expire ?? 0) + 1; if (fail) throw new Error("db"); };
  await until(d, "cardwait");
  d.state.card = "rejected";
  await probeStep(d);
  d.tick(6 * HOUR);
  assert.equal((await probeStep(d)).detail, "card-expire-retry");
  fail = false;
  d.purge = async () => { d.calls.purge++; return "in_progress"; };
  d.tick(6 * HOUR);
  r = await probeStep(d);
  assert.deepEqual([r.phase, r.code, d.calls.purge], ["purge", "in_progress", 1], "a retryable first purge is not failed by the time spent expiring");
  assert.deepEqual([d.log.at(-1).at, d.log.at(-1).expireCards], [d.now().toISOString(), false]);
  d.tick(HOUR);
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal(d.calls.expire, 2, "later purge ticks do not expire again once recorded");
  d.purge = async () => { d.calls.purge++; return "done"; };
  r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["done", "card-rejected"]);
  assert.equal(d.calls.expire, 3, "r20: once purged, the cards are expired once more");
});

test("Codex PR239-r15: expireProbePurgeCards expires the project's pending purge cards and resolves only when none is left", async () => {
  const make = (reads) => {
    const seen = { q: [], expired: [] };
    const tx = { approval: { findMany: async (q) => { seen.q.push(q); return reads.shift() ?? []; } } };
    return { db: { $transaction: async (fn, o) => { seen.o = o; return fn(tx); } }, seen, expire: async (ids, reason) => { seen.expired.push({ ids, reason }); return ids; } };
  };
  let m = make([[]]);
  await expireProbePurgeCards(m.db, "p-1", 5000, m.expire);
  assert.deepEqual(m.seen.expired, [], "nothing pending: no expiry call");
  assert.deepEqual(m.seen.q[0].where, { projectId: "p-1", action: "teardown.purge", target: "project:p-1", status: "pending" });
  assert.equal(m.seen.q[0].take, 50);
  assert.deepEqual(m.seen.o, { timeout: 5000, maxWait: 5000 });
  m = make([[{ id: "c-1" }, { id: "" }, { id: "c-2" }], []]);
  await expireProbePurgeCards(m.db, "p-1", 5000, m.expire);
  assert.deepEqual(m.seen.expired, [{ ids: ["c-1", "c-2"], reason: PROBE_CARD_EXPIRE_REASON }]);
  m = make([[{ id: "c-1" }], [{ id: "c-1" }]]);
  await assert.rejects(expireProbePurgeCards(m.db, "p-1", 5000, m.expire), /probe-card-still-pending/);
  const before = new Date("2026-11-25T10:00:00Z");
  m = make([[]]);
  await expireProbePurgeCards(m.db, "p-1", 5000, m.expire, before);
  assert.deepEqual(m.seen.q[0].where.createdAt, { lt: before }, "only an earlier archive's cards when bounded");
  m = make([[{ id: "c-1" }]]);
  await assert.rejects(expireProbePurgeCards(m.db, "p-1", 5000, async () => { throw new Error("db"); }), /db/);
});

test("Codex PR239-r15: raiseProbePurgeCard expires an earlier archive's pending card before a new raise, and only then", async () => {
  const AT = new Date("2026-11-25T10:00:00Z");
  const seen = [];
  const deps = (over = {}) => ({ outlasts: async () => true, stage: async () => "archived", archivedAt: async () => AT, existing: async () => null, archive: async () => {}, counts: async () => ({}),
    expireStale: async (b) => { seen.push(["expire", b]); }, raise: async () => { seen.push(["raise"]); return { id: "card-new", createdAt: new Date(AT.getTime() + 1) }; }, ...over });
  assert.equal(await raiseProbePurgeCard("p-1", deps()), "card-new");
  assert.deepEqual(seen, [["expire", AT], ["raise"]]);
  seen.length = 0;
  assert.equal(await raiseProbePurgeCard("p-1", deps({ existing: async () => "card-1" })), "card-1");
  assert.equal(await raiseProbePurgeCard("p-1", deps({ outlasts: async () => false })), CARD_GRANT_SHORT);
  assert.deepEqual(seen, [], "no expiry when this archive has its card or no card is raised");
  await assert.rejects(raiseProbePurgeCard("p-1", deps({ expireStale: async () => { throw new Error("probe-card-still-pending"); } })), /still-pending/);
  assert.deepEqual(seen, [], "a stale card that stays pending raises nothing");
});

test("Codex PR239-r17: a sweep purge under KK's card that finishes after cardwait gave up still passes as AT10's proof", async () => {
  const run = async (state) => {
    const d = fake();
    await until(d, "cardwait");
    d.state.card = "approved"; d.state.decidedAt = d.now().toISOString();
    d.tick(PROBE_PHASE_MAX_MS);
    assert.equal((await probeStep(d)).phase, "purge");
    assert.equal(d.log.at(-1).result.code, "card-purge-unfinished");
    // The sweep completes before the fallback tick; the probe's purge finds the row purged.
    Object.assign(d.state, state);
    d.tick(6 * HOUR);
    return probeStep(d);
  };
  assert.deepEqual(await run({ stage: "purged" }), { exit: 0, phase: "done", cycle: 1, code: "pass-card", detail: undefined });
  // Not proven under an approved card's grant (r1), or no longer approved: the earlier failure stands.
  assert.equal((await run({ stage: "purged", byCard: false })).code, "card-purge-unfinished");
  assert.equal((await run({ stage: "purged", card: "missing" })).code, "card-purge-unfinished");
  // A read that throws keeps the earlier failure.
  const d = fake();
  await until(d, "cardwait");
  d.state.card = "rejected";
  await probeStep(d);
  d.cardOutcome = async () => { throw new Error("db"); };
  assert.equal((await probeStep(d)).code, "card-rejected");
  // A normal cycle never reads a card.
  const n = fake();
  n.state.proven = true;
  assert.equal((await until(n, "done")).code, "pass");
  assert.equal(n.calls.outcome, 0);
});

test("Codex PR239-r19: the archived-state checks and the raise run under the lifecycle lock; a Restore waits for it", async () => {
  const AT = new Date("2026-11-25T09:00:00Z");
  let stage = "archived";
  let held = false;
  const order = [];
  // A Restore that takes the same lock: it can only run once the locked part has ended.
  let waiting = null;
  const locked = async (fn) => {
    assert.equal(held, false, "the lock is never taken twice");
    held = true; order.push("lock");
    try { return await fn(); } finally { held = false; order.push("unlock"); if (waiting) { const w = waiting; waiting = null; w(); } }
  };
  const restore = () => new Promise((resolve) => { const go = () => { stage = "live"; order.push("restore"); resolve(); }; if (held) waiting = go; else go(); });
  const d = {
    stage: async () => { order.push(`stage:${stage}:${held}`); return stage; },
    archivedAt: async () => (stage === "archived" ? AT : null),
    existing: async () => null,
    archive: async () => { assert.equal(held, false, "the Archive takes the lock itself"); order.push("archive"); stage = "archived"; },
    counts: async () => { void restore(); return { github: 1 }; },
    outlasts: async () => true,
    expireStale: async () => {},
    raise: async () => { assert.equal(held, true, "raised under the lock"); assert.equal(stage, "archived"); order.push("raise"); return { id: "card-1", createdAt: AT }; },
    locked,
  };
  assert.equal(await raiseProbePurgeCard("p-1", d), "card-1");
  assert.deepEqual(order.filter((o) => !o.startsWith("stage")), ["lock", "raise", "unlock", "restore"]);
  assert.ok(order.includes("stage:archived:true"), "the archived state is read inside the lock");
  // From live: the Archive runs first, outside the lock, then the locked raise.
  stage = "live"; order.length = 0;
  d.counts = async () => ({ github: 1 });
  assert.equal(await raiseProbePurgeCard("p-1", d), "card-1");
  assert.deepEqual(order.filter((o) => !o.startsWith("stage")), ["archive", "lock", "raise", "unlock"]);
  // Restored before the lock was taken: the locked check sees it and no card is raised.
  stage = "live"; order.length = 0;
  d.archive = async () => { stage = "archived"; };
  const restoreFirst = { ...d, locked: async (fn) => { stage = "live"; return locked(fn); } };
  await assert.rejects(raiseProbePurgeCard("p-1", restoreFirst), /probe-card-not-archived/);
  assert.ok(!order.includes("raise"));
  // A lock that cannot be taken raises nothing.
  stage = "archived";
  await assert.rejects(raiseProbePurgeCard("p-1", { ...d, locked: async () => { throw new Error("lock_timeout"); } }), /lock_timeout/);
});

test("Codex PR239-r20: a card asked for during the fallback purge is expired once the row is purged", async () => {
  // KK's "Ask to delete now" raises a card after the pre-purge expiry; the purge then finishes.
  const pending = new Set();
  const d = fake({ purge: async () => { pending.add("asked-card"); d.calls.purge++; return "done"; } });
  let fail = 0;
  d.expirePurgeCards = async () => { if (fail > 0) { fail--; throw new Error("db"); } pending.clear(); };
  await until(d, "cardwait");
  d.state.card = "rejected";
  assert.equal((await probeStep(d)).phase, "purge");
  let r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["done", "card-rejected"]);
  assert.equal(pending.size, 0, "no pending card is left for a purged project");
  // A failing post-purge expiry holds the cycle in purge (one row per call) and is retried; the purge is a no-op then.
  const e = fake({ purge: async () => { e.calls.purge++; return "done"; } });
  fail = 0;
  e.expirePurgeCards = async () => { if (fail > 0) { fail--; throw new Error("db"); } };
  await until(e, "cardwait");
  e.state.card = "expired";
  await probeStep(e);
  // The pre-purge expiry fails once (held while the grant lasts), then the post-purge one fails once.
  let call = 0;
  e.expirePurgeCards = async () => { call++; if (call === 1 || call === 3) throw new Error("db"); };
  e.grantUntil = e.now().getTime() + 3 * DAY;
  assert.equal((await probeStep(e)).detail, "card-expire-retry");
  r = await probeStep(e);
  assert.deepEqual([r.phase, r.detail], ["purge", "card-expire-after-purge"]);
  r = await probeStep(e);
  assert.deepEqual([r.phase, r.code], ["done", "card-expired"]);
  // Past the phase bound the cycle ends as it would have.
  const t = fake({ purge: async () => "done" });
  t.expirePurgeCards = async () => {};
  await until(t, "cardwait");
  t.state.card = "rejected";
  await probeStep(t);
  t.expirePurgeCards = async () => { if (t.calls.pre === undefined) { t.calls.pre = 1; return; } throw new Error("db"); };
  r = await probeStep(t);
  assert.equal(r.detail, "card-expire-after-purge");
  t.tick(PROBE_PHASE_MAX_MS);
  r = await probeStep(t);
  assert.deepEqual([r.phase, r.code], ["done", "card-rejected"]);
  // A normal cycle never expires.
  const n = fake();
  n.state.proven = true;
  await until(n, "done");
  assert.equal(n.calls.expire, undefined);
});

test("Codex PR239-r23 (DEVOS-254 d22): a pass-card in cardwait first expires the probe's pending purge cards; a failed expiry waits", async () => {
  const d = fake();
  await until(d, "cardwait");
  d.state.card = "approved"; d.state.decidedAt = d.now().toISOString(); d.state.byCard = true;
  d.state.stage = "purged";
  let fail = true;
  d.calls.expire = 0;
  d.expirePurgeCards = async () => { d.calls.expire++; if (fail) throw new Error("db"); };
  let r = await probeStep(d);
  assert.deepEqual(r, { exit: 3, phase: "cardwait", cycle: 1, code: "in_progress", detail: "card-expire-after-purge" });
  // Codex PR239-r24: a short or unreadable grant does not divert a purged, proven cycle into the fallback purge.
  d.cardGrantOutlasts = async () => false;
  r = await probeStep(d);
  assert.equal(r.detail, "card-expire-after-purge");
  d.cardGrantOutlasts = async () => { throw new Error("db"); };
  r = await probeStep(d);
  assert.equal(r.detail, "card-expire-after-purge");
  assert.equal(d.log.at(-1).phase, "cardwait");
  // Codex PR239-r25: the proof is recorded; an outcome read that now fails does not lose it.
  assert.equal(d.log.at(-1).cardProven, true);
  const reads = d.calls.outcome;
  d.cardOutcome = async () => { throw new Error("db"); };
  r = await probeStep(d);
  assert.equal(r.detail, "card-expire-after-purge");
  assert.equal(d.calls.outcome, reads, "the card is not read again");
  fail = false;
  r = await probeStep(d);
  assert.deepEqual(r, { exit: 0, phase: "done", cycle: 1, code: "pass-card", detail: undefined });
  assert.equal(d.calls.expire, 5);
  assert.equal(d.calls.purge, 0);
});
