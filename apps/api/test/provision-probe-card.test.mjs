// DEVOS-254 (M2.5-b4, docs/modules/M2.5.md "M2.5-b4 decisions"): one AT13 probe cycle purges through KK's purge card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStep, PROBE_CARD_MAX_MS, PROBE_PHASE_MAX_MS, PROBE_SLUG } from "../dist/provision-probe.js";
import { archiveUnderProbeGrant, probeActiveCounts, probeCardCycle, probeCardOutcome, probeExistingCard, raiseProbePurgeCard } from "../dist/provision-probe-purge.js";

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
    cardOutcome: async (id) => { calls.outcome++; assert.equal(id, "card-1"); return { stage: state.stage, card: state.card, decidedAt: state.decidedAt, byCard: state.byCard }; },
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

test("a card read that throws waits, then times out; a failed raise or an empty id is purged by the probe", async () => {
  let d = fake();
  await until(d, "cardwait");
  d.cardOutcome = async () => { throw new Error("db"); };
  assert.equal((await probeStep(d)).detail, "card-unreadable");
  d.tick(PROBE_CARD_MAX_MS);
  assert.equal((await probeStep(d)).phase, "purge");
  assert.equal((await probeStep(d)).code, "card-timeout");

  for (const raise of [async () => { throw new Error("x"); }, async () => ""]) {
    d = fake({ raisePurgeCard: raise });
    await until(d, "card");
    assert.equal((await probeStep(d)).phase, "purge");
    const r = await probeStep(d);
    assert.equal(r.code, "card-raise-failed");
    assert.equal(d.calls.purge, 1);
  }
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
  const id = await raiseProbePurgeCard("p-1", {
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
  await raiseProbePurgeCard("p-1", { stage: async () => "archived", archivedAt: async () => AT, existing: async () => null, archive: async () => { archived++; }, counts: async () => ({}), raise: async () => ({ id: "card-9", createdAt: AT }) });
  assert.equal(archived, 0);
  // An archive that did not reach `archived`, a purged row, or no id: no card is used.
  await assert.rejects(raiseProbePurgeCard("p-1", { stage: async () => "live", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "x", createdAt: LATER }) }), /probe-card-not-archived/);
  await assert.rejects(raiseProbePurgeCard("p-1", { stage: async () => "purged", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "x", createdAt: LATER }) }), /probe-card-already-purged/);
  await assert.rejects(raiseProbePurgeCard("p-1", { stage: async () => "archived", archive: async () => {}, archivedAt: async () => AT, existing: async () => null, counts: async () => ({}), raise: async () => ({ id: "", createdAt: LATER }) }), /probe-card-not-raised/);
  // Pre-review 2: a pending twin from an earlier archive (or one with no times) is never used.
  for (const [archivedAt, createdAt] of [[AT, EARLIER], [null, LATER], [AT, undefined]]) {
    await assert.rejects(raiseProbePurgeCard("p-1", { stage: async () => "archived", archivedAt: async () => archivedAt, existing: async () => null, archive: async () => {}, counts: async () => ({}), raise: async () => ({ id: "old", createdAt }) }), /probe-card-stale/);
  }
});

/** A fake db for the two bounded reads. */
function db({ project = { stage: "archived" }, approval = null, count = 0 } = {}) {
  const seen = {};
  const tx = {
    project: { findUnique: async (q) => { seen.project = q; return project; } },
    approval: { findUnique: async (q) => { seen.approval = q; return approval; } },
    auditEvent: { count: async (q) => { seen.count = q; return count; } },
  };
  return { seen, $transaction: async (fn, o) => { seen.opts = o; return fn(tx); } };
}

test("probeCardOutcome reads only this project's own purge card; probeCardCycle reads the probe's phase log", async () => {
  const at = new Date("2026-11-25T10:00:00Z");
  let x = db({ approval: { status: "approved", decidedAt: at, projectId: "p-1", action: "teardown.purge" } });
  assert.deepEqual(await probeCardOutcome(x, "p-1", "c-1", 5000), { stage: "archived", card: "approved", decidedAt: at.toISOString(), byCard: false });
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
    const id = await raiseProbePurgeCard("p-1", {
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
  const run = async (decisions) => {
    const seen = {};
    const tx = {
      project: { findUnique: async () => ({ stage: "purged" }) },
      approval: { findUnique: async () => card },
      policyDecision: { findMany: async (q) => { seen.q = q; return decisions; } },
    };
    const out = await probeCardOutcome({ $transaction: async (fn) => fn(tx) }, "p-1", "c-1", 5000);
    return { out, seen };
  };
  const mine = { approvalGrant: { approvalId: "c-1" } };
  let r = await run([mine, mine]);
  assert.equal(r.out.byCard, true);
  assert.deepEqual(r.seen.q.where, { projectId: "p-1", ts: { gte: created }, enforcedOutcome: "allow", action: { path: ["type"], equals: "teardown.purge" } });
  assert.equal(r.seen.q.take, 50);
  for (const ds of [[], [mine, { approvalGrant: { approvalId: "other" } }], [{ approvalGrant: null }], Array(50).fill(mine)]) {
    assert.equal((await run(ds)).out.byCard, false, JSON.stringify(ds).slice(0, 80));
  }
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
  const id = await raiseProbePurgeCard("p-1", {
    stage: async () => "archived", archivedAt: async () => AT,
    existing: async () => (reads++ === 0 ? null : "card-first"),
    archive: async () => {}, counts: async () => ({}), raise: async () => ({ id: "card-probe", createdAt: LATER }),
  });
  assert.equal(id, "card-first");
  assert.equal(reads, 2);
});
