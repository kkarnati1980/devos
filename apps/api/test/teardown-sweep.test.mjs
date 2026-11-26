// DEVOS-245 (M2.5-b2, docs/modules/M2.5.md "M2.5-b2 decisions"): the purge card and the teardown jobs, with the real
// M2.3 approvals core (memory store) and the real M1.7 engine issuing and checking the card's grant. AT3 through the
// jobs: no approved card → zero purge calls; the purge-due job only raises a card; Keep archived moves purge_after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { TeardownError } from "@devos/teardown";
import { KkSessionRegistry } from "../dist/auth.js";
import { Approvals, MemoryApprovalStore, parseCard, EXPIRE_IDS_MAX } from "../dist/approvals.js";
import {
  TeardownSweepJob, purgeCard, purgeStoppedCard, stopWhys, countsText, istClock, withLimit, PurgeTimeout,
  PURGE_ACTION, PURGE_STOPPED_ACTION, KEEP_ARCHIVED_MS, PURGE_TIME_LIMIT_MS,
  cardArchive, cardDue, stopWhy, stopAt, beforeDeletion, CARD_PAGE, CLEANUP_SCAN_MAX, EXPIRE_BATCH,
} from "../dist/teardown-sweep.js";
import { buildTeardownSweep, purgeCardAuthorizer } from "../dist/teardown-runtime.js";

const KEY = Buffer.alloc(32, 7);
const P = "11111111-2222-4333-8444-555555555555";
const Q = "22222222-2222-4333-8444-555555555555";
const DAY = 86_400_000;
// 03:15 IST on 17 Nov 2026 (21:45 UTC on 16 Nov): just after the daily run's time.
const T0 = Date.parse("2026-11-16T21:45:00Z");
const SECRET = "ghp_TESTONLY_not_a_real_token_0123456789";

const purgeRule = {
  id: "r-purge", name: "purge needs KK", version: 1, priority: 10, actions: ["teardown.*"], resources: [], principals: [],
  roles: [], environments: [], effect: "require_approval", constraints: {}, enabled: true,
};

function setup({ purgeImpl, purgeTimeoutMs, mode = "enforce", rules = [purgeRule] } = {}) {
    const failDue = { n: 0 };
  const failRaise = { n: 0 };
  let now = T0;
  const kk = new KkSessionRegistry();
  const policyStore = new MemoryPolicyStore({ mode, rules });
  const engine = new PolicyEngine({ store: policyStore, hmacKey: KEY, now: () => now, verifyKkSession: kk.verify });
  const store = new MemoryApprovalStore();
  const approvals = new Approvals({ store, grants: engine, notifier: null, verifyKkSession: kk.verify, now: () => now });
  const projects = new Map([[P, { id: P, slug: "acme", stage: "archived", archivedAt: new Date(T0 - 31 * DAY), purgeAfter: new Date(T0 - DAY) }]]);
  const counts = { [P]: { github: 2, coolify: 5 } };
  const calls = { purge: [], providerCalls: 0, keep: [] };
  const logs = [];
  const purge = async (projectId, grantId, card) => {
    calls.purge.push({ projectId, grantId });
    // The real purge checks `teardown.purge` once before any provider call (M2.5-a1), with the production authorizer.
    const d = await purgeCardAuthorizer(engine, projectId, grantId, card, async () => projects.get(projectId)?.archivedAt ?? null, async () => projects.get(projectId)?.purgeAfter ?? null)("teardown.purge", `project:${projectId}`);
    if (d !== "allow") throw new TeardownError("approval_required", false, "approval needed");
    calls.providerCalls++;
    if (purgeImpl) return purgeImpl(projectId);
    projects.get(projectId).stage = "purged";
    return { purged: true, report: { hits: [], errors: [] } };
  };
  const job = new TeardownSweepJob({
    listDue: async (at, limit) => {
      if (failDue.n > 0) { failDue.n--; throw new Error("db blip"); }
      return [...projects.values()].filter((p) => p.stage === "archived" && p.purgeAfter && p.purgeAfter <= at).slice(0, limit).map((p) => ({ ...p }));
    },
    project: async (id) => (projects.has(id) ? { ...projects.get(id) } : null),
    activeCounts: async (id) => ({ ...(counts[id] ?? {}) }),
    cards: (f) => approvals.store.list(f),
    raise: (c) => {
      if (failRaise.n > 0) { failRaise.n--; return Promise.reject(new Error("db blip")); }
      return approvals.raiseCard(c);
    },
    expire: (ids, reason) => approvals.expireCardsById(ids, reason),
    supersede: (oldId, c, reason) => approvals.supersedeCard(oldId, c, reason),
    unspentGrant: async (approvalId, at) => {
      return [...policyStore.grants].find((g) => g.approvalId === approvalId && !g.revokedAt && g.expiresAt > at && g.uses === 0)?.id ?? null;
    },
    purge,
    keepArchived: async (id, from, to, approvalId, archivedAt) => {
      const p = projects.get(id);
      if (!p || p.stage !== "archived" || p.purgeAfter?.getTime() !== from.getTime() || p.archivedAt?.getTime() !== archivedAt?.getTime()) return false;
      p.purgeAfter = to;
      calls.keep.push({ id, to, approvalId });
      return true;
    },
    log: (e) => logs.push(e),
    now: () => now,
    purgeTimeoutMs,
  });
  const session = kk.mint("kk@example.com");
  const purgeCards = (status) => approvals.store.list({ action: PURGE_ACTION, limit: 50, ...(status ? { status } : {}) });
  return { failDue, failRaise, job, approvals, store, engine, policyStore, projects, counts, calls, logs, session, purgeCards, advance: (ms) => (now += ms), now: () => now };
}

const approve = (s, id) => s.approvals.approve(s.session, id, { confirmation: `PURGE project:${P}` });

test("AT3: the daily run only raises one gate-5 purge card naming per-provider counts; no approved card → zero purge calls", async () => {
  const s = setup();
  await s.job.tick();
  const cards = await s.purgeCards();
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.gate, "purge");
  assert.equal(c.action, "teardown.purge");
  assert.equal(c.target, `project:${P}`);
  assert.equal(c.projectId, P);
  assert.match(c.reason, /^Purge project acme\? This deletes its code, stacks, data and backups for good\./);
  assert.match(c.reason, /Coolify: 5, GitHub: 2/);
  assert.match(c.consequence, /Reject to keep acme archived for another 30 days/);
  assert.match(c.consequence, /Restore/);
  assert.equal(s.calls.purge.length, 0, "the purge-due job never purges");
  assert.equal(s.calls.providerCalls, 0);
  // More ticks, the same day and later days, with the card pending: no second card, still no purge.
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1);
  assert.equal(s.calls.purge.length, 0);
});

test("AT3: an approved card (typed confirmation) runs the purge once under its grant; the grant is then used up", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await assert.rejects(s.approvals.approve(s.session, c.id, {}), /purge-confirmation-mismatch/);
  await approve(s, c.id);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1);
  assert.equal(s.calls.providerCalls, 1);
  const grant = [...s.policyStore.grants].find((g) => g.approvalId === c.id);
  assert.equal(s.calls.purge[0].grantId, grant.id);
  assert.equal(grant.uses, 1);
  assert.equal(s.projects.get(P).stage, "purged");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purged" && l.projectId === P));
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1, "no second purge");
  assert.equal((await s.purgeCards()).length, 1, "a purged project gets no new card");
});

test("AT3: an approved card whose grant KK revoked never purges (zero provider calls)", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  const { grantId } = await approve(s, c.id);
  assert.equal(await s.engine.revokeGrant(s.session, grantId), true);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 0);
  assert.equal(s.calls.providerCalls, 0);
  assert.equal(s.projects.get(P).stage, "archived");
});

test("AT3: Keep archived (reject) moves purge_after by 30 days, once; no purge; the card is raised again only in the new period", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(2 * DAY);
  await s.approvals.reject(s.session, c.id);
  const decidedAt = s.now();
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
  assert.equal(s.projects.get(P).purgeAfter.getTime(), decidedAt + KEEP_ARCHIVED_MS);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "moved once");
  assert.equal(s.calls.purge.length, 0);
  assert.equal((await s.purgeCards()).length, 1, "no card before the new purge_after");
  s.advance(30 * DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "a new card after the new purge_after");
});

test("decision 58 (Codex PR240-r53): a scheduled card whose app-clock creation time is before purge_after still gets Keep archived", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  // The approvals clock was behind the database's: the stored creation time is before purge_after.
  s.store.cards.get(c.id).createdAt = new Date(s.projects.get(P).purgeAfter.getTime() - 1000);
  s.advance(DAY);
  await s.approvals.reject(s.session, c.id);
  const decidedAt = s.now();
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "Keep archived applies to the scheduled card");
  assert.equal(s.projects.get(P).purgeAfter.getTime(), decidedAt + KEEP_ARCHIVED_MS);
});

test("decision 58 (Codex PR240-r53): skewed scheduled cards still count against the single re-raise", async () => {
  const s = setup();
  const skew = async () => {
    for (const c of await s.purgeCards("pending")) s.store.cards.get(c.id).createdAt = new Date(s.projects.get(P).purgeAfter.getTime() - 1000);
  };
  await s.job.tick();
  await skew();
  s.advance(8 * DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "re-raised once");
  await skew();
  s.advance(8 * DAY);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "no third card");
  assert.equal((await s.purgeCards("expired")).length, 2);
});

test("decision 59 (Codex PR240-r54): an early ask made after the purge date names it, so a skewed rejection still gets Keep archived", async () => {
  const s = setup();
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  const c = s.store.cards.get(r.approvalId);
  assert.equal(cardDue(c), s.projects.get(P).purgeAfter.toISOString(), "the ask names the purge date");
  c.createdAt = new Date(s.projects.get(P).purgeAfter.getTime() - 1000);
  s.advance(DAY);
  await s.approvals.reject(s.session, c.id);
  const decidedAt = s.now();
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
  assert.equal(s.projects.get(P).purgeAfter.getTime(), decidedAt + KEEP_ARCHIVED_MS);
  // Before the purge date, an early ask still names no date, and its rejection leaves purge_after as it is.
  const s2 = setup();
  s2.projects.get(P).purgeAfter = new Date(T0 + 10 * DAY);
  const r2 = await s2.job.askPurge(P);
  assert.equal(cardDue(s2.store.cards.get(r2.approvalId)), null);
  await s2.approvals.reject(s2.session, r2.approvalId);
  await s2.job.tick();
  assert.equal(s2.calls.keep.length, 0);
});

test("decision 60 (Codex PR240-r55 1): an ask whose wait crosses the purge date still names it", async () => {
  // The date passes while the ask reads the inventory counts.
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + 500);
  Object.defineProperty(s.counts, P, { get: () => { s.advance(1000); return { github: 2 }; } });
  const r = await s.job.askPurge(P);
  assert.equal(cardDue(s.store.cards.get(r.approvalId)), new Date(T0 + 500).toISOString());
  // The date passes while the card is written: the unstamped card is replaced by one that names the date.
  const s2 = setup();
  s2.projects.get(P).purgeAfter = new Date(T0 + 500);
  const raise = s2.store.raise.bind(s2.store);
  let first = true;
  s2.store.raise = async (...a) => { const out = await raise(...a); if (first) { first = false; s2.advance(1000); } return out; };
  const r2 = await s2.job.askPurge(P);
  assert.equal(r2.ok, true);
  const pending = await s2.purgeCards("pending");
  assert.deepEqual(pending.map((c) => c.id), [r2.approvalId]);
  assert.equal(cardDue(pending[0]), new Date(T0 + 500).toISOString());
  assert.equal((await s2.purgeCards("expired")).length, 1, "the unstamped card was expired");
});

test("decision 60 (Codex PR240-r55 2): a same-archive stop replacing an owed one keeps the later stamp", async () => {
  const s = setup();
  const p = { ...s.projects.get(P) };
  s.failRaise.n = 10;
  // An owed stop whose entry already carries a later stamp (copied from a twin, decision 47).
  s.job.stopsOwed.set(P, { p, code: "ownership_mismatch", due: null, at: T0 + 5000, also: [] });
  await s.job.raiseStopped(p, "provider_error");
  const o = s.job.stopsOwed.get(P);
  assert.equal(o.code, "provider_error");
  assert.equal(o.at, T0 + 5000, "the stamp never moves backward");
});

// A card raised by main's code before decision 8: the same words, no Archive (or Due) stamp.
const legacyPurgeCard = (s) => purgeCard({ ...s.projects.get(P), archivedAt: null }, { github: 2 });
const legacyStopCard = (s) => purgeStoppedCard({ ...s.projects.get(P), archivedAt: null }, "ownership_mismatch", { github: 2 });

test("decision 61 (Codex PR240-r56 1): a pending or approved card from before the stamp keeps working after the deploy", async () => {
  const s = setup();
  const legacy = await s.approvals.raiseCard(legacyPurgeCard(s));
  assert.equal(cardArchive(legacy), null);
  await s.job.tick();
  assert.equal((await s.store.get(legacy.id)).status, "pending", "cleanup leaves the unanswered card alone");
  assert.equal((await s.purgeCards("pending")).length, 1, "and no second card is raised");
  await approve(s, legacy.id);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1, "the approval KK gave before the deploy purges");
  assert.equal(s.calls.providerCalls, 1, "its authorizer allows it");
  assert.equal(s.projects.get(P).stage, "purged");
  // A card from an earlier archive (raised before archived_at) is still stale.
  const s2 = setup();
  const old = await s2.approvals.raiseCard(legacyPurgeCard(s2));
  s2.projects.get(P).archivedAt = new Date(T0 + 1000);
  s2.projects.get(P).purgeAfter = new Date(T0 + 1000);
  s2.advance(2000);
  await s2.job.tick();
  assert.equal((await s2.store.get(old.id)).status, "expired");
});

test("decision 61 (Codex PR240-r56 1): Keep archived on a card from before the stamp moves the date once; its stop card stays open", async () => {
  const s = setup();
  const legacy = await s.approvals.raiseCard(legacyPurgeCard(s));
  await s.approvals.reject(s.session, legacy.id);
  const from = s.projects.get(P).purgeAfter.getTime();
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
  assert.equal(s.projects.get(P).purgeAfter.getTime(), Math.max(from, T0) + KEEP_ARCHIVED_MS);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "once");
  assert.equal((await s.purgeCards("pending")).length, 0, "no card is raised for the moved date yet");
  // An unstamped stop card of the current archive is not closed, and it holds back a new purge card.
  const s2 = setup();
  const stop = await s2.approvals.raiseCard(legacyStopCard(s2));
  await s2.job.tick();
  assert.equal((await s2.store.get(stop.id)).status, "pending");
  assert.equal((await s2.purgeCards("pending")).length, 0);
});

test("decision 62 (Codex PR240-r56 2): a card raised as the date passes that KK rejects before the repair is his Keep archived", async () => {
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + 500);
  const raise = s.store.raise.bind(s.store);
  let first = true;
  s.store.raise = async (...a) => {
    const out = await raise(...a);
    if (first) { first = false; s.advance(1000); await s.approvals.reject(s.session, out.card?.id ?? out.id); }
    return out;
  };
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal((await s.store.get(r.approvalId)).status, "rejected");
  assert.equal(s.calls.keep.length, 1, "the rejection moved the purge date");
  assert.equal(s.projects.get(P).purgeAfter.getTime(), T0 + 1000 + KEEP_ARCHIVED_MS);
  assert.equal((await s.purgeCards("pending")).length, 0, "nothing re-raised");
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
  assert.equal((await s.purgeCards("pending")).length, 0, "the daily run does not ask again");
});

test("decision 63 (Codex PR240-r57): KK rejecting the card between the repair's read and its expiry is still his Keep archived", async () => {
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + 500);
  const raise = s.store.raise.bind(s.store);
  let first = true;
  s.store.raise = async (...a) => { const out = await raise(...a); if (first) { first = false; s.advance(1000); } return out; };
  const expireIds = s.store.expireIds.bind(s.store);
  s.store.expireIds = async (ids, at, reason) => {
    if (reason === "purge-card-now-due") for (const id of ids) await s.approvals.reject(s.session, id);
    return expireIds(ids, at, reason);
  };
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal((await s.store.get(r.approvalId)).status, "rejected");
  assert.equal(s.calls.keep.length, 1, "the rejection moved the purge date");
  assert.equal((await s.purgeCards("pending")).length, 0, "no replacement card was raised");
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
  assert.equal((await s.purgeCards("pending")).length, 0, "the daily run does not ask again");
});

test("decision 1: the job itself expires an unanswered card after 7 days and re-raises it once, then nothing happens (Codex PR181-r2)", async () => {
  const s = setup();
  await s.job.tick();
  s.advance(8 * DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "re-raised once");
  s.advance(8 * DAY);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
  const expired = await s.purgeCards("expired");
  assert.equal(expired.length, 2);
  assert.ok(s.store.audit.some((a) => a.details?.reason === "purge-card-unanswered-7-days" || JSON.stringify(a).includes("purge-card-unanswered-7-days")));
  assert.equal(s.calls.purge.length, 0);
});

test("decision (d): Restore closes the pending card; a card approved before Restore never purges", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.projects.get(P).stage = "building";
  await s.job.tick();
  assert.equal((await s.store.get(c.id)).status, "expired");
  // Archived again, a new card is approved, then KK restores before the next tick.
  s.projects.get(P).stage = "archived";
  s.advance(DAY);
  await s.job.tick();
  const [c2] = await s.purgeCards("pending");
  await approve(s, c2.id);
  s.projects.get(P).stage = "building";
  await s.job.tick();
  assert.equal(s.calls.purge.length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stage-building"));
});

test("decision (c): a non-retryable stop raises one plain-language card naming what is left, never the provider message", async () => {
  const s = setup({
    purgeImpl: async () => {
      throw new TeardownError("ownership_mismatch", false, `github said: Bad credentials ${SECRET}`, { provider: "github", kind: "repo", externalId: "1", name: "devos-acme" });
    },
  });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  await s.job.tick();
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(stops.length, 1);
  const stop = stops[0];
  assert.equal(stop.gate, "decision");
  assert.equal(stop.target, `project:${P}`);
  assert.match(stop.reason, /^Deleting project acme stopped: DevOS could not prove that it owns one of the project's resources/);
  assert.match(stop.reason, /Still recorded \(by provider\): Coolify: 5, GitHub: 2\./);
  const all = JSON.stringify({ stop, logs: s.logs });
  assert.ok(!all.includes(SECRET) && !all.includes("Bad credentials"), "no provider text anywhere");
  assert.equal(s.projects.get(P).stage, "archived");
  // The grant is used up; the next daily run does not raise a new purge card while the stop card is open.
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("decision (c): one attempt per approval: a retryable stop never re-runs on the same card; the daily run asks again", async () => {
  let mode = "retry";
  const s = setup({
    purgeImpl: async () => {
      if (mode === "retry") throw new TeardownError("delete_unconfirmed", true, "timeout");
      return { purged: false, report: { hits: [{ provider: "github", kind: "repo" }], errors: [] } };
    },
  });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, maxUses: 3, expiresInHours: 72 });
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-unfinished" && l.code === "delete_unconfirmed"));
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1, "the spent card is never run again, even with uses left");
  const fresh = await s.purgeCards("pending");
  assert.equal(fresh.length, 1, "the daily run raises a fresh card");
  mode = "leftover";
  await approve(s, fresh[0].id);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 2);
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(stops.length, 1);
  assert.match(stops[0].reason, /the leftover check still found resources of this project/);
});

test("pre-review 2: a non-retryable stop on a multi-use grant is never re-run", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("provider_forbidden", false, "403"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, maxUses: 3, expiresInHours: 72 });
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("pre-review 1: approve, Restore, Archive again → the old card never purges", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, expiresInHours: 72 });
  const p = s.projects.get(P);
  p.stage = "building";
  await s.job.tick();
  s.advance(60_000);
  p.stage = "archived";
  p.archivedAt = new Date(s.now());
  p.purgeAfter = new Date(s.now() + 30 * DAY);
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 0);
  assert.equal(p.stage, "archived");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "card-before-archive"));
});

test("pre-review 5: a failed daily run is tried again on the next tick", async () => {
  const s = setup();
  s.failDue.n = 1;
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1);
});

test("decision (c): the purge has a 10-minute limit; a run that ends after it still reports its outcome", async () => {
  assert.equal(PURGE_TIME_LIMIT_MS, 10 * 60_000);
  const s = setup({
    purgeImpl: () => new Promise((r) => setTimeout(() => r({ purged: false, report: { hits: [{ provider: "coolify", kind: "application" }], errors: [] } }), 60)),
    purgeTimeoutMs: 20,
  });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  await s.job.tick();
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-timeout"));
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1, "late leftovers still raise the stop card");
  await assert.rejects(withLimit(new Promise(() => {}), 5), (e) => e instanceof PurgeTimeout);
  assert.equal(await withLimit(Promise.resolve(7), 1000), 7);
});

test("the daily run starts at 03:10 IST, once per IST day", async () => {
  assert.deepEqual(istClock(Date.parse("2026-11-16T21:40:00Z")), { day: "2026-11-17", minute: 190 });
  const s = setup();
  s.advance(-10 * 60_000); // 03:05 IST: too early
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  s.advance(5 * 60_000); // 03:10 IST
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1);
});

test("a project not yet past purge_after gets no card; a second due project gets its own", async () => {
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + DAY);
  s.projects.set(Q, { id: Q, slug: "beta", stage: "archived", archivedAt: new Date(T0 - 30 * DAY), purgeAfter: new Date(T0 - 1) });
  await s.job.tick();
  const cards = await s.purgeCards();
  assert.deepEqual(cards.map((c) => c.projectId), [Q]);
  assert.match(cards[0].reason, /nothing recorded/);
});

test("card text is fixed: it passes card validation, and a bad slug or provider id never reaches it", () => {
  const card = purgeCard({ id: P, slug: "acme" }, { github: 1, "bad provider": 3, coolify: 0 });
  assert.deepEqual(parseCard(card), { ...card, costUsd: null });
  assert.match(card.reason, /GitHub: 1\.$/);
  assert.equal(countsText({}), "nothing recorded");
  const odd = purgeStoppedCard({ id: P, slug: "Robert'); DROP" }, "something_new", { github: 1 });
  assert.match(odd.reason, /^Deleting project \(unnamed\) stopped: it stopped with an error it cannot retry\./);
  assert.equal(typeof parseCard(odd), "object");
});

test("wiring: buildTeardownSweep is off, with a code, without its modules, the vault, the approvals core or settings", () => {
  const base = { mod: null, td: null, db: {}, databaseUrl: "postgresql://x", vault: null, policy: { decide: async () => ({ enforcedOutcome: "deny" }) }, cards: null, env: {}, timeoutMs: 1000, log: () => {} };
  assert.deepEqual(buildTeardownSweep(base), { off: "teardown-not-loaded" });
  const mods = { ...base, mod: {}, td: {} };
  assert.deepEqual(buildTeardownSweep(mods), { off: "teardown-vault-not-configured" });
  assert.deepEqual(buildTeardownSweep({ ...mods, vault: { reveal: async () => null } }), { off: "teardown-approvals-off" });
  const off = buildTeardownSweep({ ...mods, vault: { reveal: async () => null }, cards: { list: async () => [], raise: async () => ({}), expire: async () => [] } });
  assert.ok("off" in off && typeof off.off === "string");
});

test("pre-review 6: the production queries: an unspent grant only, and Keep archived is conditional and audited", async () => {
  const seen = [];
  const tx = {
    approvalGrant: { findMany: async (q) => { seen.push(["grant", q]); return [{ id: "g1", uses: 0, maxUses: 1 }]; } },
    project: { updateMany: async (q) => { seen.push(["update", q]); return { count: 1 }; } },
    auditEvent: { create: async (q) => { seen.push(["audit", q]); return {}; } },
  };
  const db = { $transaction: async (fn, o) => { seen.push(["tx", o]); return fn(tx); } };
  class Store { project() { return null; } activeResources() { return []; } }
  const mod = { GitHubClient: class {}, CoolifyClient: class {} };
  const job = buildTeardownSweep({
    mod, td: { PrismaTeardownStore: Store }, db, databaseUrl: "postgresql://x", vault: { reveal: async () => null },
    policy: { decide: async () => ({ enforcedOutcome: "deny" }) }, cards: { list: async () => [], raise: async () => ({}), expire: async () => [] },
    env: { DEVOS_GITHUB_OWNER: "acme", DEVOS_COOLIFY_URL: "https://coolify.example.com", DEVOS_COOLIFY_SERVER_UUID: "srv-1", DEVOS_TAILNET_IP: "100.64.0.7", GIT_SHA: "a".repeat(40) }, timeoutMs: 1000, log: () => {},
  });
  assert.ok(!("off" in job), JSON.stringify(job.off));
  const now = new Date(T0);
  assert.equal(await job.d.unspentGrant("a1", now), "g1");
  const g = seen.find((x) => x[0] === "grant")[1];
  assert.deepEqual(g.where, { approvalId: "a1", revokedAt: null, expiresAt: { gt: now }, uses: 0 });
  const from = new Date(T0), to = new Date(T0 + KEEP_ARCHIVED_MS);
  const archivedAt = new Date(T0 - 31 * DAY);
  assert.equal(await job.d.keepArchived(P, from, to, "a1", archivedAt), true);
  assert.deepEqual(seen.find((x) => x[0] === "update")[1], { where: { id: P, stage: "archived", purgeAfter: from, archivedAt }, data: { purgeAfter: to } });
  const audit = seen.find((x) => x[0] === "audit")[1].data;
  assert.equal(audit.action, "teardown.keep_archived");
  assert.equal(audit.details.approvalId, "a1");
  assert.ok(seen.filter((x) => x[0] === "tx").every((x) => x[1].timeout === 1000 && x[1].maxWait === 1000), "every read bounded");
});

test("pre-review r2 1: observe mode or an allow rule never purges un-gated; one approval = at most one attempt", async () => {
  const allowRule = { ...purgeRule, id: "r-allow", effect: "allow" };
  for (const opts of [{ mode: "observe", rules: [] }, { mode: "enforce", rules: [allowRule] }]) {
    const s = setup(opts);
    await s.job.tick();
    const [c] = await s.purgeCards("pending");
    await approve(s, c.id);
    await s.job.tick();
    s.advance(10 * 60_000);
    await s.job.tick();
    s.advance(DAY);
    await s.job.tick();
    assert.equal(s.calls.providerCalls, 0, `${opts.mode}: refused at the check, nothing deleted`);
    assert.equal(s.calls.purge.length, 1, `${opts.mode}: one attempt only`);
    assert.equal(s.projects.get(P).stage, "archived");
  }
});

test("pre-review r2 2 (amended by decision 56): the authorizer refuses a card of an older archive, re-read when the purge asks", async () => {
  const s = setup();
  let archivedAt = new Date(T0);
  // A card built from an earlier archive (its stamp names T0 - 1) is refused against the archive of T0.
  const old = purgeCardAuthorizer(s.engine, P, "00000000-0000-4000-8000-0000000000ff", { createdAt: new Date(T0 + 5), archive: new Date(T0 - 1).toISOString() }, async () => archivedAt);
  assert.equal(await old("teardown.purge", `project:${P}`), "deny");
  const auth = purgeCardAuthorizer(s.engine, P, "00000000-0000-4000-8000-0000000000ff", { createdAt: new Date(T0 - 1), archive: new Date(T0).toISOString() }, async () => archivedAt);
  assert.equal(await auth("teardown.archive", `project:${P}`), "deny");
  // Re-read on every ask: after a Restore and a new Archive, or with no archive, this card is refused.
  archivedAt = new Date(T0 + 60_000);
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
  archivedAt = null;
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
});

test("decision 56 (Codex PR240-r52): app-clock skew never expires or denies a card built from the current archive", async () => {
  const s = setup();
  // The card's creation time (app clock) is 1 s before archived_at (database clock), but it names this archive.
  const archive = new Date(T0).toISOString();
  const auth = purgeCardAuthorizer(s.engine, P, "00000000-0000-4000-8000-0000000000ff", { createdAt: new Date(T0 - 1000), archive }, async () => new Date(T0));
  // Not refused on the binding: it reaches the policy check, which for an unknown grant asks for approval.
  assert.notEqual(await auth("teardown.purge", `project:${P}`), "deny");
  // End to end: the database's clock is 1 s ahead, so archived_at is later than the card's app-clock creation time.
  s.projects.get(P).archivedAt = new Date(T0 + 1000);
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  assert.ok(c, "the daily card was raised");
  assert.ok(c.createdAt.getTime() < s.projects.get(P).archivedAt.getTime(), "the card's creation time is before archived_at");
  assert.equal(cardArchive(c), s.projects.get(P).archivedAt.toISOString());
  // The next tick's cleanup keeps it pending (it is not expired as a restored archive's card) ...
  s.advance(60_000);
  await s.job.tick();
  assert.deepEqual((await s.purgeCards("pending")).map((x) => x.id), [c.id]);
  // ... and once KK approves, the purge's authorizer lets it run.
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, maxUses: 1, expiresInHours: 72 });
  s.advance(60_000);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1);
  assert.equal(s.calls.providerCalls, 1, "the policy check allowed the purge");
  assert.equal(s.projects.get(P).stage, "purged");
});

test("pre-review r2 3: not_archived (Restore while waiting for the lock) is a skip, never a stop card, and not re-run", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("not_archived", false, "x"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, maxUses: 3, expiresInHours: 72 });
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "not-archived"));
});

test("Codex PR181-r1: a stop card that could not be raised is retried on the next tick", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("ownership_mismatch", false, "x"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  s.failRaise.n = 1;
  await s.job.tick();
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
  assert.equal(s.calls.purge.length, 1);
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "the open stop card holds back a new purge card");
});

test("Codex PR181-r1: a due project whose card could not be raised is retried on the next tick, the same day", async () => {
  const s = setup();
  s.failRaise.n = 1;
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1, "no second card");
});


// DEVOS-246 (M2.5-b3, decision 2): KK's early ask raises the same gate-5 card; nothing is deleted until it is approved.
const early = () => {
  const s = setup();
  const p = s.projects.get(P);
  p.archivedAt = new Date(T0 - 2 * DAY);
  p.purgeAfter = new Date(T0 + 28 * DAY);
  return s;
};

test("M2.5-b3: an early ask raises one gate-5 purge card before purge_after; asking again returns it; no purge until approved", async () => {
  const s = early();
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal(r.raised, true);
  const cards = await s.purgeCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, r.approvalId);
  assert.equal(cards[0].gate, "purge");
  assert.match(cards[0].reason, /Coolify: 5, GitHub: 2/);
  assert.deepEqual(await s.job.askPurge(P), { ok: true, approvalId: r.approvalId, raised: false });
  assert.equal(await s.job.pendingCard(s.projects.get(P)), r.approvalId);
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 1, "the job raises no second card");
  assert.equal(s.calls.purge.length, 0, "an ask never purges");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-asked" && l.approvalId === r.approvalId));
  await approve(s, r.approvalId);
  assert.equal(await s.job.pendingCard(s.projects.get(P)), null, "only a pending card is linked");
  assert.deepEqual(await s.job.askPurge(P), { ok: false, code: "purge-already-approved" });
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1, "the approved early card purges once, before purge_after");
  assert.equal(s.projects.get(P).stage, "purged");
  assert.deepEqual(await s.job.askPurge(P), { ok: false, code: "not_archived" });
});

test("M2.5-b3: a rejected early card leaves purge_after as is and does not use up the daily run's card", async () => {
  const s = early();
  const { approvalId } = await s.job.askPurge(P);
  await s.approvals.reject(s.session, approvalId);
  const before = s.projects.get(P).purgeAfter.getTime();
  await s.job.tick();
  assert.equal(s.calls.keep.length, 0);
  assert.equal(s.projects.get(P).purgeAfter.getTime(), before);
  s.advance(29 * DAY);
  await s.job.tick();
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1, "the daily run still raises its card after purge_after");
  assert.notEqual(pending[0].id, approvalId);
  assert.equal(s.calls.purge.length, 0);
});

test("M2.5-b3: unknown and not-archived projects are refused; a pending card from an earlier archive is closed, never linked", async () => {
  const s = early();
  assert.deepEqual(await s.job.askPurge(Q), { ok: false, code: "project-not-found" });
  s.projects.get(P).stage = "building";
  assert.deepEqual(await s.job.askPurge(P), { ok: false, code: "not_archived" });
  assert.equal(await s.job.pendingCard(s.projects.get(P)), null);
  assert.equal((await s.purgeCards()).length, 0);
  // A card raised in an earlier archive, then Restore and Archive again before the job's next tick.
  s.projects.get(P).stage = "archived";
  const old = await s.job.askPurge(P);
  s.advance(60_000);
  s.projects.get(P).archivedAt = new Date(s.now());
  assert.equal(await s.job.pendingCard(s.projects.get(P)), null, "an old archive's card is not linked");
  const r = await s.job.askPurge(P);
  assert.equal(r.raised, true);
  assert.notEqual(r.approvalId, old.approvalId);
  assert.equal((await s.store.get(old.approvalId)).status, "expired");
  assert.equal(await s.job.pendingCard(s.projects.get(P)), r.approvalId);
});

// Pre-review (M2.5-b3) 1 and 2: the ask after a stopped, waiting or still-running approved purge. The grant stays
// unspent here (a stop before the policy check spent it), which is the case that could dead-end KK's ask.
function askHarness(purgeImpl) {
  const now = T0;
  const p = { id: P, slug: "acme", stage: "archived", archivedAt: new Date(T0 - 2 * DAY), purgeAfter: new Date(T0 + 28 * DAY) };
  const approved = { id: "33333333-2222-4333-8444-555555555555", status: "approved", action: PURGE_ACTION, target: `project:${P}`, projectId: P, createdAt: new Date(T0 - DAY), decidedAt: new Date(T0 - DAY), reason: `Purge? Archive ${p.archivedAt.toISOString()}.` };
  const cards = [approved];
  const raised = [];
  const job = new TeardownSweepJob({
    listDue: async () => [],
    project: async (id) => (id === P ? { ...p } : null),
    activeCounts: async () => ({ github: 1 }),
    cards: async (f) => cards.filter((c) => (!f.status || c.status === f.status) && c.action === f.action && (!f.target || c.target === f.target)),
    raise: async (c) => {
      if (c.action !== PURGE_ACTION) return { id: "stop" };
      const card = { ...c, id: `44444444-2222-4333-8444-55555555555${raised.length}`, status: "pending", createdAt: new Date(now) };
      raised.push(card);
      cards.push(card);
      return card;
    },
    expire: async () => [],
    unspentGrant: async () => "g1",
    purge: purgeImpl,
    keepArchived: async () => false,
    log: () => {},
    now: () => now,
    purgeTimeoutMs: 5,
  });
  return { job, raised };
}

test("pre-review 1 (M2.5-b3): after an approved purge stopped for good, the early ask raises a new card", async () => {
  const h = askHarness(async () => { throw new TeardownError("policy_denied", false, "denied"); });
  assert.deepEqual(await h.job.askPurge(P), { ok: false, code: "purge-already-approved" }, "before the job ran it, the approval is queued");
  await h.job.tick();
  const r = await h.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal(r.raised, true);
  assert.equal(h.raised.length, 1);
});

test("pre-review 1 (M2.5-b3): a retryable stop with the grant unspent answers purge-waits-for-daily-run", async () => {
  const h = askHarness(async () => { throw new TeardownError("provider_error", true, "blip"); });
  await h.job.tick();
  assert.deepEqual(await h.job.askPurge(P), { ok: false, code: "purge-waits-for-daily-run" });
  assert.equal(h.raised.length, 0);
});

test("pre-review 2 (M2.5-b3): while a purge runs past its 10-minute limit, the ask raises no second card", async () => {
  let finish;
  const h = askHarness(() => new Promise((resolve) => { finish = resolve; }));
  await h.job.tick();
  assert.deepEqual(await h.job.askPurge(P), { ok: false, code: "purge-already-approved" });
  finish({ purged: true, report: { hits: [], errors: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.raised.length, 0);
});

// M2.5-b5 decision 1 (DEVOS-255, from Codex PR239-r21): KK's early ask holds the lifecycle lock, so no card follows a Purge.
test("M2.5-b5 AT1: an early ask runs under the lifecycle lock; one waiting on a purge sees not_archived and raises nothing", async () => {
  const s = early();
  // A lock with one holder at a time, as the store's advisory lock.
  let tail = Promise.resolve();
  const seen = [];
  s.job.d.locked = (id, fn) => {
    seen.push(id);
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  // A purge (another process) holds the lock and moves the row to purged before releasing it.
  let release;
  const held = s.job.d.locked(P, () => new Promise((r) => { release = r; }));
  const ask = s.job.askPurge(P);
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.purgeCards()).length, 0, "the ask waits for the lock");
  s.projects.get(P).stage = "purged";
  release();
  await held;
  assert.deepEqual(await ask, { ok: false, code: "not_archived" });
  assert.equal((await s.purgeCards()).length, 0, "no card for a purged project");
  assert.deepEqual(seen, [P, P]);
  // Archived again: the locked ask raises its card as before.
  s.projects.get(P).stage = "archived";
  const r = await s.job.askPurge(P);
  assert.equal(r.raised, true);
  // A lock that cannot be taken raises nothing.
  s.job.d.locked = async () => { throw new Error("lock_timeout"); };
  s.projects.get(P).archivedAt = new Date(s.now());
  await assert.rejects(s.job.askPurge(P), /lock_timeout/);
  assert.equal((await s.purgeCards("pending")).length, 1);
});

// M2.5-b5 decision 2 (DEVOS-255, from Codex PR239-r22): the daily run's due check and raise hold the lifecycle lock on a fresh read.
const serialLock = () => {
  let tail = Promise.resolve();
  const seen = [];
  const locked = (id, fn) => {
    seen.push(id);
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  return { locked, seen };
};

test("M2.5-b5 AT2: the daily run waiting on a purge's lock re-reads the row and raises no card for a purged project", async () => {
  const s = setup();
  const lock = serialLock();
  s.job.d.locked = lock.locked;
  let release;
  const held = lock.locked(P, () => new Promise((r) => { release = r; }));
  const tick = s.job.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.purgeCards()).length, 0, "the daily run waits for the lock");
  // The purge that held the lock finished (and expired its cards) before releasing it.
  s.projects.get(P).stage = "purged";
  release();
  await held;
  await tick;
  assert.equal((await s.purgeCards()).length, 0, "no card after the purge");
  assert.deepEqual(lock.seen, [P, P]);
  assert.ok(!s.logs.some((l) => l.msg === "teardown-purge-card"));
});

test("M2.5-b5 AT3: a row restored and archived again after listDue gets no card before its new purge date", async () => {
  const s = setup();
  const listDue = s.job.d.listDue;
  s.job.d.listDue = async (at, limit) => {
    const due = await listDue(at, limit);
    // Restore and a new Archive between the due check and the raise.
    const p = s.projects.get(P);
    p.archivedAt = new Date(s.now());
    p.purgeAfter = new Date(s.now() + 30 * DAY);
    return due;
  };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0, "the stale listed row raises nothing");
  // Unchanged rows still get their card, with or without the lock.
  const t = setup();
  t.job.d.locked = serialLock().locked;
  await t.job.tick();
  assert.equal((await t.purgeCards("pending")).length, 1);
});

test("M2.5-b5 AT3 (decision 23, Codex PR240-r19): a row archived again after listDue gets no card from that pass even when the new archive is already due", async () => {
  const s = setup();
  s.job.d.locked = serialLock().locked;
  const listDue = s.job.d.listDue;
  s.job.d.listDue = async (at, limit) => {
    const due = await listDue(at, limit);
    // Restore and a new Archive between the due check and the raise; the new archive is already past its purge date.
    const p = s.projects.get(P);
    p.archivedAt = new Date(s.now() - 1000);
    p.purgeAfter = new Date(s.now() - 500);
    return due;
  };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0, "no card for an archive absent from the due snapshot");
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-skipped" && l.code === "archive-changed"));
  assert.ok(!s.logs.some((l) => l.msg === "teardown-purge-card"));
});

test("M2.5-b5 AT4: a lock that cannot be taken raises nothing and keeps the daily run open", async () => {
  const s = setup();
  s.job.d.locked = async () => { throw new Error("lock_timeout"); };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "purge-due"));
  // The lock is back: the next tick raises the card.
  s.job.d.locked = serialLock().locked;
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1);
});

test("M2.5-b5 pre-review 1: while this process's own purge runs (past its limit), the ask answers at once and the daily run does not queue on the lock", async () => {
  let finish;
  const h = askHarness(() => new Promise((resolve) => { finish = resolve; }));
  const taken = [];
  // A lock that never frees, as the store's queue behind a purge that runs on.
  h.job.d.locked = (id) => { taken.push(id); return new Promise(() => {}); };
  h.job.d.listDue = async () => [{ id: P, slug: "acme", stage: "archived", archivedAt: new Date(T0 - 31 * DAY), purgeAfter: new Date(T0 - DAY) }];
  await h.job.tick();
  assert.deepEqual(await h.job.askPurge(P), { ok: false, code: "purge-already-approved" });
  assert.deepEqual(taken, [], "neither path waited on the lock");
  assert.equal(h.raised.length, 0);
  finish({ purged: true, report: { hits: [], errors: [] } });
});

test("M2.5-b5 decision 4 (Codex PR240-r1): a lock lost before the write raises no card in either path", async () => {
  // Daily run: the lock session dropped after the read; nothing is raised and the run stays open.
  const s = setup();
  s.job.d.locked = serialLock().locked;
  const checked = [];
  s.job.d.lockHeld = async (id) => { checked.push(id); throw new Error("provision_lock_lost"); };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  assert.deepEqual(checked, [P]);
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "purge-due"));
  // The lock holds again: the next tick raises the card, after the check.
  s.job.d.lockHeld = async (id) => { checked.push(id); };
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1);
  // Early ask: a lost lock rejects and raises nothing.
  const e = early();
  e.job.d.locked = serialLock().locked;
  e.job.d.lockHeld = async () => { throw new Error("provision_lock_lost"); };
  await assert.rejects(e.job.askPurge(P), /provision_lock_lost/);
  assert.equal((await e.purgeCards()).length, 0);
  e.job.d.lockHeld = async () => {};
  assert.equal((await e.job.askPurge(P)).raised, true);
});

test("M2.5-b5 decision 5 (Codex PR240-r2): a card written after the row moved to a new archive is expired at once", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  // The lock was lost after the ping: Restore and a new Archive finish before the write lands.
  s.job.d.raise = async (c) => {
    const p = s.projects.get(P);
    p.archivedAt = new Date(s.now());
    p.purgeAfter = new Date(s.now() - 1);
    return raise(c);
  };
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "the stale card is not left pending");
  assert.equal((await s.purgeCards("expired")).length, 1);
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "purge-due"), "the daily run stays open");
  // Early ask: same fence, the ask fails and leaves nothing pending.
  const e = early();
  const er = e.job.d.raise;
  e.job.d.raise = async (c) => { e.projects.get(P).stage = "active"; return er(c); };
  await assert.rejects(e.job.askPurge(P), /purge-card-stale-archive/);
  assert.equal((await e.purgeCards("pending")).length, 0);
});

test("M2.5-b5 decisions 6 and 12 (Codex PR240-r3, r8): a failed fence re-read leaves the card, which names its archive; a stale card whose expiry fails is owed, never handed out, and retried", async () => {
  const s = setup();
  const project = s.job.d.project;
  let readFails = false;
  s.job.d.project = async (id) => { if (readFails) throw new Error("db blip"); return project(id); };
  s.job.d.raise = ((raise) => async (c) => { const r = await raise(c); readFails = true; return r; })(s.job.d.raise);
  // Decision 12: the re-read after the write fails. The card (perhaps another caller's twin) is not expired; the tick fails.
  await s.job.tick();
  readFails = false;
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "purge-due"));
  assert.equal((await s.purgeCards("expired")).length, 0, "a card the fence could not read is never expired");
  const [kept] = await s.purgeCards("pending");
  assert.equal(cardArchive(kept), s.projects.get(P).archivedAt.toISOString(), "it names the current archive");
  // The next tick raises no second card, and the panel links the one there is.
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1);
  assert.equal(await s.job.pendingCard({ ...s.projects.get(P) }), kept.id);
  // Decision 6's owed list: the archive moved on (a stale card) and its expiry fails, so the card is owed its expiry.
  const t = setup();
  const te = t.job.d.expire;
  let tExp = 1;
  t.job.d.expire = async (ids, reason) => { if (tExp > 0) { tExp--; throw new Error("db blip"); } return te(ids, reason); };
  let tOnce = true;
  t.job.d.raise = ((raise) => async (c) => { const r = await raise(c); if (tOnce) { tOnce = false; t.projects.get(P).archivedAt = new Date(t.now() + 1); } return r; })(t.job.d.raise);
  await t.job.tick();
  const owed = await t.purgeCards("pending");
  assert.equal(owed.length, 1, "the expiry failed, the card is still pending");
  assert.ok(t.logs.some((l) => l.msg === "teardown-card-expiry-failed" && l.approvalId === owed[0].id));
  assert.equal(await t.job.pendingCard({ ...t.projects.get(P) }), null, "the panel never links the owed card");
  // KK's early ask never reuses the owed card, and raises none beside it.
  await assert.rejects(t.job.askPurge(P), /purge-card-unverified/);
  // The next tick expires it first, then the still-open daily run raises a fresh card for the current archive.
  t.advance(60_000);
  await t.job.tick();
  const pending = await t.purgeCards("pending");
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].id, owed[0].id);
  assert.equal((await t.purgeCards("expired")).map((c) => c.id).includes(owed[0].id), true);
  assert.equal(await t.job.pendingCard({ ...t.projects.get(P) }), pending[0].id);
});

test("M2.5-b5 decision 7 (Codex PR240-r3): a card expired early as stale does not use up the daily run's unanswered re-raise", async () => {
  const s = setup();
  // An early ask in the current period lands after a new archive (the fence expires it at once), twice.
  for (let i = 0; i < 2; i++) {
    const raise = s.job.d.raise;
    s.job.d.raise = async (c) => { s.job.d.raise = raise; s.projects.get(P).archivedAt = new Date(s.now()); return raise(c); };
    await assert.rejects(s.job.askPurge(P), /purge-card-stale-archive/);
    s.advance(1000);
  }
  assert.equal((await s.purgeCards("expired")).length, 2);
  // Both early expiries are in the current period, yet the daily run still raises its scheduled card.
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "the stale expiries did not count as unanswered");
  // Unanswered for its 7 days: it expires and is re-raised once, then nothing more (MAX_UNANSWERED = 2 still holds).
  for (let i = 0; i < 3; i++) {
    s.advance(7 * DAY + 60_000);
    await s.job.tick();
  }
  const all = await s.purgeCards();
  assert.equal(all.filter((c) => c.status === "pending").length, 0);
  assert.equal(all.filter((c) => c.status === "expired").length, 4, "2 stale + 2 unanswered, no third raise");
});

test("M2.5-b5 decision 8 (Codex PR240-r4): a card is bound to the archive it names; one built for an earlier archive never purges, even approved", async () => {
  // The fence's re-read and expiry both fail; KK approves the stale card from the inbox; then the process restarts.
  const s = setup();
  const raise = s.job.d.raise;
  s.job.d.raise = async (c) => {
    s.job.d.raise = raise;
    // Restore and a new Archive land before the write: the card names the old archive.
    s.projects.get(P).archivedAt = new Date(s.now() - 1);
    return raise(c);
  };
  const expire = s.job.d.expire;
  s.job.d.expire = async () => { throw new Error("db blip"); };
  await s.job.tick();
  s.job.d.expire = expire;
  const [stale] = await s.purgeCards("pending");
  assert.ok(stale, "the stale card is still pending (its expiry failed)");
  assert.notEqual(cardArchive(stale), s.projects.get(P).archivedAt.toISOString());
  await approve(s, stale.id);
  // A fresh job (a restart: nothing in memory) never purges on it, and the authorizer itself refuses it.
  const fresh = new TeardownSweepJob(s.job.d);
  s.advance(60_000);
  await fresh.tick();
  assert.equal(s.calls.providerCalls, 0, "no provider call on a card for an earlier archive");
  const grant = [...s.policyStore.grants].find((g) => g.approvalId === stale.id);
  const auth = purgeCardAuthorizer(s.engine, P, grant.id, { createdAt: stale.createdAt, archive: cardArchive(stale) }, async () => s.projects.get(P).archivedAt);
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
  // The current archive still gets its own card, which names it.
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString());
});

test("M2.5-b5 decision 9 (Codex PR240-r5): a pending stale card is expired by the next tick, even after a restart; rejecting one never moves purge_after", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  s.job.d.raise = async (c) => { s.job.d.raise = raise; s.projects.get(P).archivedAt = new Date(s.now() - 1); return raise(c); };
  const expire = s.job.d.expire;
  s.job.d.expire = async () => { throw new Error("db blip"); };
  await s.job.tick();
  s.job.d.expire = expire;
  const [stale] = await s.purgeCards("pending");
  assert.ok(stale);
  // A restart: the owed list is gone; the next tick still expires the stale card and raises the current one.
  const fresh = new TeardownSweepJob(s.job.d);
  s.advance(60_000);
  await fresh.tick();
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].id, stale.id);
  assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString());
  // KK rejects a stale card (one left from before): purge_after stays as it is.
  const t = setup();
  const traise = t.job.d.raise;
  t.job.d.raise = async (c) => { t.job.d.raise = traise; t.projects.get(P).archivedAt = new Date(t.now() - 1); return traise(c); };
  t.job.d.expire = async () => { throw new Error("db blip"); };
  await t.job.tick();
  const [old] = await t.purgeCards("pending");
  await t.approvals.reject(t.session, old.id);
  const before = t.projects.get(P).purgeAfter.getTime();
  t.advance(60_000);
  await new TeardownSweepJob({ ...t.job.d, listDue: async () => [] }).tick();
  assert.equal(t.projects.get(P).purgeAfter.getTime(), before, "a stale card's rejection does not move purge_after");
  assert.equal(t.calls.keep.length, 0);
});

test("M2.5-b5 decision 10 (Codex PR240-r6): a stale card's rejection or 7-day expiry never suppresses or uses up the current archive's purge cards", async () => {
  // A card built for an earlier archive lands after purge_after (its fence expiry fails), and KK rejects it.
  const t = setup();
  const traise = t.job.d.raise;
  t.job.d.raise = async (c) => { t.job.d.raise = traise; t.projects.get(P).archivedAt = new Date(t.now() - 1); return traise(c); };
  const texpire = t.job.d.expire;
  t.job.d.expire = async () => { throw new Error("db blip"); };
  await t.job.tick();
  t.job.d.expire = texpire;
  const [old] = await t.purgeCards("pending");
  assert.notEqual(cardArchive(old), t.projects.get(P).archivedAt.toISOString());
  await t.approvals.reject(t.session, old.id);
  t.advance(60_000);
  await new TeardownSweepJob(t.job.d).tick();
  const pending = await t.purgeCards("pending");
  assert.equal(pending.length, 1, "the current archive still gets its scheduled card");
  assert.equal(cardArchive(pending[0]), t.projects.get(P).archivedAt.toISOString());
  // Two stale cards that expire unanswered after their whole 7 days do not use up the current archive's quota.
  const s = setup();
  const at = s.projects.get(P).archivedAt;
  for (let i = 0; i < 2; i++) {
    const stale = await s.job.d.raise(purgeCard({ ...s.projects.get(P), archivedAt: new Date(at.getTime() - 1000 * (i + 1)) }, {}));
    assert.ok(stale?.id);
    s.advance(7 * DAY + 60_000);
    await s.job.d.expire([stale.id], "unanswered");
  }
  const all = await s.purgeCards();
  assert.equal(all.length, 2);
  assert.ok(all.every((c) => c.status === "expired" && cardArchive(c) !== at.toISOString()));
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "stale unanswered expiries do not count against the current archive");
});

test("M2.5-b5 decision 11 (Codex PR240-r7): a stale raise deduplicated onto the current archive's card never expires that card", async () => {
  for (const via of ["ask", "tick"]) {
    const s = setup();
    const raise = s.job.d.raise;
    let valid;
    s.job.d.raise = async (c) => {
      s.job.d.raise = raise;
      // Restore and a new Archive land, and another process raises the new archive's card, before this stale write.
      s.projects.get(P).archivedAt = new Date(s.now() - 1);
      valid = await raise(purgeCard({ ...s.projects.get(P) }, {}));
      return raise(c);
    };
    if (via === "ask") await assert.rejects(s.job.askPurge(P), /purge-card-other-archive/);
    else await s.job.tick();
    const pending = await s.purgeCards("pending");
    assert.equal(pending.length, 1, `${via}: the current archive's card is still pending`);
    assert.equal(pending[0].id, valid.id);
    assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString());
    assert.equal((await s.purgeCards("expired")).length, 0);
  }
});

test("M2.5-b5 decision 13 (Codex PR240-r9): an early ask never expires a pending card of a later archive, and checks the lock before any expiry", async () => {
  const s = setup();
  const cards = s.job.d.cards;
  let valid;
  s.job.d.cards = async (f) => {
    s.job.d.cards = cards;
    // The lock drops after the ask's read: another process restores, re-archives and raises the new archive's card.
    s.projects.get(P).archivedAt = new Date(s.now() + 1);
    valid = await s.approvals.raiseCard(purgeCard({ ...s.projects.get(P) }, {}));
    return cards(f);
  };
  await assert.rejects(s.job.askPurge(P), /purge-card-other-archive/);
  const pending = await s.purgeCards("pending");
  assert.deepEqual(pending.map((c) => c.id), [valid.id], "the later archive's card is still pending");
  assert.equal((await s.purgeCards("expired")).length, 0);
  // A lost lock is found before the older archive's card is expired: nothing is written.
  const t = setup();
  const old = await t.approvals.raiseCard(purgeCard({ ...t.projects.get(P), archivedAt: new Date(t.projects.get(P).archivedAt.getTime() - DAY) }, {}));
  const expired = [];
  const te = t.job.d.expire;
  t.job.d.expire = async (ids, r) => { expired.push(...ids); return te(ids, r); };
  t.job.d.lockHeld = async () => { throw new Error("lock-lost"); };
  await assert.rejects(t.job.askPurge(P), /lock-lost/);
  assert.deepEqual(expired, []);
  assert.deepEqual((await t.purgeCards("pending")).map((c) => c.id), [old.id]);
  // With the lock held, the older archive's card is expired and the current one raised.
  delete t.job.d.lockHeld;
  const r = await t.job.askPurge(P);
  assert.equal(r.raised, true);
  assert.deepEqual(expired, [old.id]);
});

test("M2.5-b5 decision 14 (Codex PR240-r10): while the daily run stays open, an approval that failed before its policy check waits for the next day", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.approve(s.session, c.id, { confirmation: `PURGE project:${P}`, expiresInHours: 72 });
  // Fails before the policy check: the grant stays unspent and nothing was written at a provider.
  let tries = 0;
  s.job.d.purge = async () => { tries++; throw new TeardownError("lock_timeout", true, "lock busy"); };
  await s.job.tick();
  assert.equal(tries, 1);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-retry"));
  // The next day's run releases it once; it fails again, and the daily run stays open (the due list cannot be read).
  s.advance(DAY);
  s.failDue.n = 1000;
  await s.job.tick();
  assert.equal(tries, 2, "the next daily run tries once");
  for (let i = 0; i < 5; i++) {
    s.advance(5 * 60_000);
    await s.job.tick();
  }
  assert.equal(tries, 2, "an open daily run never releases it again the same day");
  assert.ok(s.logs.filter((l) => l.code === "teardown-due-pass-failed").length >= 5, "the daily run is still open");
  s.advance(DAY);
  await s.job.tick();
  assert.equal(tries, 3, "the following day's run tries once more");
});

test("M2.5-b5 decision 15 (Codex PR240-r11): a pending card naming a later archive, written during the daily run, keeps it open", async () => {
  const s = setup();
  const cards = s.job.d.cards;
  let inject = true;
  s.job.d.cards = async (f) => {
    // Another process, after a lost lock, persists a card naming an archive that is not older than this read's.
    if (inject && f.target) {
      inject = false;
      const p = s.projects.get(P);
      await s.approvals.raiseCard(purgeCard({ ...p, archivedAt: new Date(p.archivedAt.getTime() + DAY) }, s.counts[P]));
    }
    return cards(f);
  };
  await s.job.tick();
  const [other] = await s.purgeCards("pending");
  assert.notEqual(cardArchive(other), s.projects.get(P).archivedAt.toISOString(), "only the other archive's card is pending");
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "purge-due"), "the daily run stays open");
  assert.ok(!s.logs.some((l) => l.msg === "teardown-purge-card"));
});

test("M2.5-b5 decision 24 (Codex PR240-r20): an older archive's pending card written during the daily run is expired under the lock and the current card follows in the same pass", async () => {
  const s = setup();
  s.job.d.locked = serialLock().locked;
  const cards = s.job.d.cards;
  let inject = true;
  s.job.d.cards = async (f) => {
    // A stale writer that lost its lock persists a card for an earlier archive after closeRestored listed the cards.
    if (inject && f.target) {
      inject = false;
      const p = s.projects.get(P);
      await s.approvals.raiseCard(purgeCard({ ...p, archivedAt: new Date(p.archivedAt.getTime() - DAY) }, s.counts[P]));
    }
    return cards(f);
  };
  await s.job.tick();
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString(), "the current archive's card, in the same pass");
  assert.equal((await s.purgeCards("expired")).length, 1, "the stale card was expired");
  assert.ok(!s.logs.some((l) => l.msg === "teardown-card-failed"), "the daily run is served");
});

test("M2.5-b5 decision 24 (Codex PR240-r20): a stale card beyond the cleanup's page never holds back the current card", async () => {
  const s = setup();
  const p = s.projects.get(P);
  const stale = await s.approvals.raiseCard(purgeCard({ ...p, archivedAt: new Date(p.archivedAt.getTime() - DAY) }, s.counts[P]));
  const cards = s.job.d.cards;
  // The cross-project page is full of newer valid cards of other projects, so the first pass never reaches this one.
  s.job.d.cards = async (f) => (f.target ? cards(f) : []);
  await s.job.tick();
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), p.archivedAt.toISOString());
  assert.ok((await s.purgeCards("expired")).some((c) => c.id === (stale.id ?? stale)), "the stale card was expired by the due pass");
});

test("M2.5-b5 decision 25 (Codex PR240-r21): the cleanup pages past a full first page of current cards to an older stale stop card and a restored project's purge card", async () => {
  const s = setup();
  const Q = "33333333-3333-4333-8333-333333333333";
  s.projects.set(Q, { id: Q, slug: "gone", stage: "active", archivedAt: null, purgeAfter: null });
  const old = { id: P, slug: "acme", archivedAt: new Date(T0 - 60 * DAY) };
  const staleStop = await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 }));
  const restoredCard = await s.approvals.raiseCard(purgeCard({ id: Q, slug: "gone", archivedAt: new Date(T0 - 40 * DAY) }, { github: 1 }));
  s.advance(1);
  // A full page (and more) of newer cards that are all still valid: other projects' current archives, not yet due.
  for (let i = 0; i < CARD_PAGE + 5; i++) {
    const id = `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`;
    const at = new Date(T0 - DAY);
    s.projects.set(id, { id, slug: `p${i}`, stage: "archived", archivedAt: at, purgeAfter: new Date(T0 + 29 * DAY) });
    await s.approvals.raiseCard(purgeStoppedCard({ id, slug: `p${i}`, archivedAt: at }, "leftover", { github: 1 }));
    await s.approvals.raiseCard(purgeCard({ id, slug: `p${i}`, archivedAt: at }, { github: 1 }));
  }
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "expired", "the ended archive's stop card is closed");
  assert.equal((await s.approvals.store.get(restoredCard.id)).status, "expired", "the restored project's purge card is closed");
  const live = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 200 });
  assert.equal(live.filter((c) => c.target !== `project:${P}`).length, CARD_PAGE + 5, "current stop cards stay open");
});

test("M2.5-b5 decision 26 (Codex PR240-r22): a cleanup scan that stops at its bound resumes on the next tick and reaches an older stale stop card", async () => {
  const s = setup();
  const old = { id: P, slug: "acme", archivedAt: new Date(T0 - 60 * DAY) };
  const staleStop = await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 }));
  s.advance(1);
  for (let i = 0; i < CLEANUP_SCAN_MAX + 5; i++) {
    const id = `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`;
    const at = new Date(T0 - DAY);
    s.projects.set(id, { id, slug: `p${i}`, stage: "archived", archivedAt: at, purgeAfter: new Date(T0 + 29 * DAY) });
    await s.approvals.raiseCard(purgeStoppedCard({ id, slug: `p${i}`, archivedAt: at }, "leftover", { github: 1 }));
  }
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "pending", "the first scan stops at its bound");
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "expired", "the next tick resumes and closes it");
});

test("M2.5-b5 decision 27 (Codex PR240-r23): a failed cleanup keeps its resume point, so the next tick re-reads the same batch", async () => {
  const s = setup();
  const old = { id: P, slug: "acme", archivedAt: new Date(T0 - 60 * DAY) };
  s.advance(1);
  for (let i = 0; i < CLEANUP_SCAN_MAX + 5; i++) {
    const id = `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`;
    const at = new Date(T0 - DAY);
    s.projects.set(id, { id, slug: `p${i}`, stage: "archived", archivedAt: at, purgeAfter: new Date(T0 + 29 * DAY) });
    await s.approvals.raiseCard(purgeStoppedCard({ id, slug: `p${i}`, archivedAt: at }, "leftover", { github: 1 }));
  }
  // A stale stop card inside the first (newest) batch, and an expiry that fails once.
  const staleStop = await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 }));
  const expire = s.job.d.expire;
  let fail = 1;
  s.job.d.expire = async (ids, reason) => {
    if (reason === "stop-card-archive-ended" && fail-- > 0) throw new Error("db blip");
    return expire(ids, reason);
  };
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "pending", "the failed expiry left it open");
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "expired", "the next tick re-reads the same batch and closes it");
});

test("M2.5-b5 decision 28 (Codex PR240-r24): the job's expiry chunk is the approvals API's limit", () => {
  assert.equal(EXPIRE_BATCH, EXPIRE_IDS_MAX);
  assert.ok(CLEANUP_SCAN_MAX > EXPIRE_IDS_MAX, "a full cleanup batch needs more than one expiry call");
});

test("M2.5-b5 decision 28 (Codex PR240-r24): more stale cards than one expiry call takes are all closed in one tick, in chunks the approvals API accepts", async () => {
  const s = setup();
  s.projects.clear();
  const N = EXPIRE_IDS_MAX + 100;
  const stops = [];
  const purges = [];
  for (let i = 0; i < N; i++) {
    const id = `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`;
    const old = { id, slug: `p${i}`, archivedAt: new Date(T0 - 60 * DAY) };
    stops.push(await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 })));
    purges.push(await s.approvals.raiseCard(purgeCard({ ...old, stage: "archived" }, { github: 1 })));
    // Restored since (purge card stale), then archived again (stop card names an ended archive).
    s.projects.set(id, { id, slug: `p${i}`, stage: "active", archivedAt: null, purgeAfter: null });
  }
  const sizes = [];
  const expire = s.job.d.expire;
  s.job.d.expire = async (ids, reason) => {
    sizes.push(ids.length);
    return expire(ids, reason);
  };
  await s.job.tick();
  assert.ok(sizes.length >= 4 && sizes.every((n) => n <= EXPIRE_IDS_MAX), `chunked expiry calls: ${sizes}`);
  for (const c of [...stops, ...purges]) assert.equal((await s.approvals.store.get(c.id)).status, "expired");
  assert.equal(s.logs.filter((l) => l.msg === "teardown-sweep-failed").length, 0);
});

test("M2.5-b5 decision 28 (Codex PR240-r24): a failed purge-card cleanup never holds back the stop-card cleanup", async () => {
  const s = setup();
  const old = { id: P, slug: "acme", archivedAt: new Date(T0 - 60 * DAY) };
  const staleStop = await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 }));
  s.projects.get(P).stage = "active";
  await s.approvals.raiseCard(purgeCard({ ...old, stage: "archived" }, { github: 1 }));
  const expire = s.job.d.expire;
  s.job.d.expire = async (ids, reason) => {
    if (reason === "project-not-archived") throw new Error("db blip");
    return expire(ids, reason);
  };
  await s.job.tick();
  assert.equal((await s.approvals.store.get(staleStop.id)).status, "expired", "the stop cleanup ran");
  assert.ok(s.logs.some((l) => l.code === "teardown-restored-pass-failed"));
  assert.ok(!s.logs.some((l) => l.code === "teardown-stop-cleanup-failed"));
});

test("M2.5-b5 decision 29 (Codex PR240-r25): a daily card written after Keep archived moved purge_after is expired, and the next pass raises nothing", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  let once = 1;
  s.job.d.raise = async (c) => {
    // A lost-lock early ask's card was rejected and Keep archived applied between the locked read and the write.
    if (once-- > 0) s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    return raise(c);
  };
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "no actionable card after the archive was extended");
  const [c] = await s.purgeCards("expired");
  assert.ok(c, "the card this raise wrote was expired");
  assert.ok(s.logs.some((l) => l.code === "purge-due"), "the daily run stays open");
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "the row is no longer due");
});

test("M2.5-b5 decision 29 (Codex PR240-r25): a deduplicated twin stored before the raise (KK's early ask) is never expired by the purge-date fence", async () => {
  const s = setup();
  const counts = s.job.d.activeCounts;
  let twin = null;
  s.job.d.activeCounts = async (id) => {
    // KK's early ask stores this archive's card just before the daily raise begins.
    if (!twin) {
      twin = await s.approvals.raiseCard(purgeCard(s.projects.get(P), { github: 2, coolify: 5 }));
      s.advance(1);
    }
    return counts(id);
  };
  const raise = s.job.d.raise;
  s.job.d.raise = async (c) => {
    s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    return raise(c);
  };
  await s.job.tick();
  assert.equal((await s.approvals.store.get(twin.id)).status, "pending", "the early ask's card stays open");
  assert.equal((await s.purgeCards()).length, 1, "nothing else was written");
});

test("M2.5-b5 decision 30 (Codex PR240-r26): a scheduled card names its purge date; an early ask names none", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  assert.equal(cardDue(c), s.projects.get(P).purgeAfter.toISOString());
  assert.equal(cardArchive(c), s.projects.get(P).archivedAt.toISOString(), "the archive stamp still reads back");
  assert.equal(cardDue(purgeCard(s.projects.get(P), { github: 1 })), null);
});

test("M2.5-b5 decision 30 (Codex PR240-r26): a scheduled card left pending after a failed purge-date re-read is expired by the next cleanup", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  const project = s.job.d.project;
  let armed = false;
  s.job.d.raise = async (c) => {
    const r = await raise(c);
    s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    armed = true;
    return r;
  };
  s.job.d.project = async (id) => {
    if (armed) { armed = false; throw new Error("db blip"); }
    return project(id);
  };
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  assert.ok(c, "the failed re-read left the card pending");
  s.job.d.raise = raise;
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(c.id)).status, "expired", "the cleanup expired the no-longer-due card");
  assert.equal((await s.purgeCards("pending")).length, 0);
});

test("M2.5-b5 decision 30 (Codex PR240-r26): an approved scheduled card whose purge date moved never purges, and the authorizer refuses it", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  // Keep archived (from another card) moved the purge date after this card was raised.
  s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 0, "no purge ran");
  assert.ok(s.logs.some((l) => l.code === "purge-card-not-due"));
  const stored = await s.approvals.store.get(c.id);
  const grant = [...s.policyStore.grants].find((g) => g.approvalId === c.id);
  const auth = purgeCardAuthorizer(s.engine, P, grant.id, { createdAt: stored.createdAt, archive: cardArchive(stored), due: cardDue(stored) },
    async () => s.projects.get(P).archivedAt, async () => s.projects.get(P).purgeAfter);
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
  const noDueGetter = purgeCardAuthorizer(s.engine, P, grant.id, { createdAt: stored.createdAt, archive: cardArchive(stored), due: cardDue(stored) },
    async () => s.projects.get(P).archivedAt);
  assert.equal(await noDueGetter("teardown.purge", `project:${P}`), "deny", "a scheduled card needs the purge date read");
});

test("M2.5-b5 decision 30 (Codex PR240-r26): an early ask stored while the daily raise is in flight is never expired by the purge-date fence", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  let twin = null;
  s.job.d.raise = async (c) => {
    // After a lost lock, KK's early ask stores its card during the daily raise, then Keep archived moves the date.
    twin = await s.approvals.raiseCard(purgeCard(s.projects.get(P), { github: 2, coolify: 5 }));
    s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    return raise(c);
  };
  await s.job.tick();
  assert.equal((await s.approvals.store.get(twin.id)).status, "pending", "the early ask's card stays open");
});

test("M2.5-b5 decision 31 (Codex PR240-r27): an approved scheduled card whose purge date moved never blocks a new card", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const p = s.projects.get(P);
  p.purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
  const early = await s.job.askPurge(P);
  assert.equal(early.ok, true, `the early ask is not told a purge is approved: ${JSON.stringify(early)}`);
  assert.notEqual(early.approvalId, c.id);
  assert.equal(s.calls.purge.length, 0);
});

test("M2.5-b5 decision 31 (Codex PR240-r27): the daily run is not served by an approval whose purge date moved", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const p = s.projects.get(P);
  // Keep archived moved the date before the approved purge ran; the new date is now due too.
  p.purgeAfter = new Date(s.now() + 1000);
  s.advance(DAY);
  await s.job.tick();
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1, "the new purge date gets its own card");
  assert.equal(cardDue(pending[0]), p.purgeAfter.toISOString());
});

test("M2.5-b5 decision 31 (Codex PR240-r27): an early ask never hands out a pending scheduled card whose purge date moved, and the panel hides it", async () => {
  const s = setup();
  await s.job.tick();
  const [stale] = await s.purgeCards("pending");
  s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
  assert.equal(await s.job.pendingCard({ ...s.projects.get(P) }), null, "the panel does not link the stale card");
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal(r.raised, true, "a fresh card was raised");
  assert.notEqual(r.approvalId, stale.id);
  assert.equal((await s.approvals.store.get(stale.id)).status, "expired");
  assert.equal(cardDue(await s.approvals.store.get(r.approvalId)), null, "the early ask names no purge date");
});

test("M2.5-b5 decision 32 (Codex PR240-r28): an early ask never hands out a same-archive scheduled twin whose purge date moved", async () => {
  const s = setup();
  const raise = s.job.d.raise;
  let twin = null;
  s.job.d.raise = async (c) => {
    // A daily raise (after a lost lock) stores its scheduled card after the ask listed pending cards; then Keep
    // archived moves the date, and the ask's raise dedupes onto that card.
    const p = s.projects.get(P);
    twin = await s.approvals.raiseCard(purgeCard(p, { github: 2, coolify: 5 }, { due: p.purgeAfter }));
    p.purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    return raise(c);
  };
  const r = await s.job.askPurge(P).catch((e) => ({ ok: false, code: e.message }));
  assert.ok(twin, "the twin was stored");
  assert.notEqual(r.approvalId, twin.id, `the stale twin is never handed out: ${JSON.stringify(r)}`);
  assert.equal((await s.approvals.store.get(twin.id)).status, "expired", "the stale twin is expired");
});

test("M2.5-b5 decision 32 (Codex PR240-r28): a purge denied because Keep archived moved the date raises no stop card", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  // Keep archived moves the purge date after approvedPass validated the card, before the purge took its lock.
  const purge = s.job.d.purge;
  s.job.d.purge = async (...a) => { s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS); return purge(...a); };
  await s.job.tick();
  assert.equal(s.calls.providerCalls, 0, "nothing was deleted");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "no stop card");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "purge-card-not-due"));
});

test("M2.5-b5 decision 33 (Codex PR240-r29): Keep archived waits for the project lock a purge holds, and reads the row under it", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(2 * DAY);
  await s.approvals.reject(s.session, c.id);
  const lock = serialLock();
  s.job.d.locked = lock.locked;
  let release;
  // A purge (another card's) holds the lifecycle lock across its authorizer's purge-date read and its deletes.
  const held = lock.locked(P, () => new Promise((r) => { release = r; }));
  const tick = s.job.tick();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.keep.length, 0, "the move waits for the lock");
  assert.ok(lock.seen.length >= 2 && lock.seen.every((id) => id === P));
  // The purge finished before it released the lock: the move then finds the row purged and writes nothing.
  s.projects.get(P).stage = "purged";
  release();
  await held;
  await tick;
  assert.equal(s.calls.keep.length, 0, "no move for a purged project");
  assert.ok(!s.logs.some((l) => l.msg === "teardown-keep-archived"));
});

test("M2.5-b5 decision 33 (Codex PR240-r29): Keep archived writes nothing when the lock is lost or times out, and retries next tick", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(2 * DAY);
  await s.approvals.reject(s.session, c.id);
  s.job.d.locked = serialLock().locked;
  s.job.d.lockHeld = async () => { throw new Error("provision_lock_lost"); };
  await s.job.tick();
  assert.equal(s.calls.keep.length, 0, "a lost lock moves nothing");
  assert.ok(s.logs.some((l) => l.msg === "teardown-keep-failed"));
  s.job.d.locked = async () => { throw new Error("lock_timeout"); };
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 0, "a lock timeout moves nothing");
  s.job.d.locked = serialLock().locked;
  s.job.d.lockHeld = async () => {};
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "the next tick moves the date once");
});

test("M2.5-b5 decision 34 (Codex PR240-r30): Keep archived never queues on the lock behind this process's running purge, nor for a rejection that no longer applies", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(2 * DAY);
  await s.approvals.reject(s.session, c.id);
  const taken = [];
  s.job.d.locked = (id) => { taken.push(id); return new Promise(() => {}); };
  s.job.purging.add(P);
  await s.job.tick();
  assert.deepEqual(taken, [], "no lock is queued while the purge runs");
  assert.ok(s.logs.some((l) => l.msg === "teardown-keep-deferred" && l.code === "purge-running"));
  assert.equal(s.calls.keep.length, 0);
  // A rejection that no longer applies (the project was purged) takes no lock either.
  s.job.purging.delete(P);
  s.projects.get(P).stage = "purged";
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.deepEqual(taken, []);
  // The purge ended with the project still archived: the next tick moves the date once.
  s.projects.get(P).stage = "archived";
  s.job.d.locked = serialLock().locked;
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1);
});

test("M2.5-b5 decision 34 (Codex PR240-r30): a stop for a scheduled card whose date moved is dropped at delivery when the handler's re-read failed", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const purge = s.job.d.purge;
  const project = s.job.d.project;
  let armed = false;
  s.job.d.purge = async (...a) => {
    s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    try { return await purge(...a); } finally { armed = true; }
  };
  s.job.d.project = async (id) => {
    if (armed) { armed = false; throw new Error("db blip"); }
    return project(id);
  };
  await s.job.tick();
  assert.equal(s.calls.providerCalls, 0, "nothing was deleted");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "no stop card");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "purge-card-not-due"));
});

test("M2.5-b5 decision 35 (Codex PR240-r31): a stop after deletions ran is reported even when Keep archived moved the date", async () => {
  const s = setup({ purgeImpl: async () => {
    // A resource was deleted, then a later one failed its ownership check; Keep archived moved the date meanwhile.
    s.projects.get(P).purgeAfter = new Date(s.now() + KEEP_ARCHIVED_MS);
    throw new TeardownError("ownership_mismatch", false, "not ours");
  } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  await s.job.tick();
  assert.equal(s.calls.providerCalls, 1, "the purge got past its authorizer");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1, "KK gets the stop card");
  assert.ok(!s.logs.some((l) => l.code === "purge-card-not-due" && l.msg === "teardown-purge-skipped"));
});

test("M2.5-b5 decision 35 (Codex PR240-r31): a failed project read skips only that rejection; later cards in the batch still move their dates", async () => {
  const s = setup();
  s.projects.set(Q, { id: Q, slug: "beta", stage: "archived", archivedAt: new Date(T0 - 30 * DAY), purgeAfter: new Date(T0 - 1) });
  await s.job.tick();
  const cards = await s.purgeCards("pending");
  assert.equal(cards.length, 2);
  s.advance(2 * DAY);
  for (const c of cards) await s.approvals.reject(s.session, c.id);
  const project = s.job.d.project;
  const first = (await s.approvals.store.list({ status: "rejected", action: cards[0].action, limit: 10 }))[0].projectId;
  s.job.d.project = async (id) => { if (id === first) throw new Error("db blip"); return project(id); };
  await s.job.tick();
  assert.deepEqual(s.calls.keep.map((k) => k.id), [first === P ? Q : P], "the other project's date moved");
  assert.ok(s.logs.some((l) => l.msg === "teardown-keep-failed" && l.projectId === first));
});

test("M2.5-b5 decision 26 (Codex PR240-r22): a rejection never postpones a replacement archive that kept the same purge date", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await s.approvals.reject(s.session, c.id);
  const p = s.projects.get(P);
  const before = p.purgeAfter.getTime();
  const keep = s.job.d.keepArchived;
  s.job.d.keepArchived = async (...a) => {
    // A Restore and a new Archive with the same purge date land between the pass's read and its write.
    p.archivedAt = new Date(p.archivedAt.getTime() + 1000);
    return keep(...a);
  };
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(p.purgeAfter.getTime(), before, "the new archive's purge date is not moved");
  assert.equal(s.calls.keep.length, 0);
});

test("M2.5-b5 decision 16 (Codex PR240-r12): an early ask hands out an existing card only behind the fence; a superseded card is never returned", async () => {
  // The ask's read sees the old archive; the lock drops and the project is restored and archived again before the
  // card list, which still returns the old archive's pending card.
  const s = setup();
  const r0 = await s.job.askPurge(P);
  assert.equal(r0.raised, true);
  const cards = s.job.d.cards;
  s.job.d.cards = async (f) => {
    s.job.d.cards = cards;
    s.projects.get(P).archivedAt = new Date(s.now() + 1);
    return cards(f);
  };
  await assert.rejects(s.job.askPurge(P), /purge-card-stale-archive/);
  assert.deepEqual((await s.purgeCards("pending")).map((c) => c.id), [r0.approvalId], "nothing expired by the ask");
  // A lost lock hands out nothing either.
  const t = setup();
  const t0 = await t.job.askPurge(P);
  t.job.d.lockHeld = async () => { throw new Error("lock-lost"); };
  await assert.rejects(t.job.askPurge(P), /lock-lost/);
  // With the lock held and the same archive, the existing card is returned as before.
  delete t.job.d.lockHeld;
  assert.deepEqual(await t.job.askPurge(P), { ok: true, approvalId: t0.approvalId, raised: false });
});

test("M2.5-b5 decision 17 (Codex PR240-r13): a purge denied because the project was restored and archived again raises no stop card", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  // Restore and a new Archive land after approvedPass read the row, before the purge took its lock.
  const purge = s.job.d.purge;
  s.job.d.purge = async (...a) => { s.projects.get(P).archivedAt = new Date(s.now()); return purge(...a); };
  await s.job.tick();
  assert.equal(s.calls.providerCalls, 0);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "no stop card");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "archive-superseded"));
  // A real stop on the same archive still raises its card.
  const t = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await t.job.tick();
  const [d] = await t.purgeCards("pending");
  await t.approvals.approve(t.session, d.id, { confirmation: `PURGE project:${P}` });
  await t.job.tick();
  assert.equal((await t.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("M2.5-b5 decision 18 (Codex PR240-r14): a stop card from an earlier archive never blocks the current archive's purge card, and is closed", async () => {
  // A: Restore and a new Archive land while the stop card is being built (after deliverStops' re-read).
  const s = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const counts = s.job.d.activeCounts;
  let flip = true;
  s.job.d.activeCounts = async (id) => {
    if (flip && (await s.approvals.store.list({ action: PURGE_ACTION, status: "approved", limit: 5 })).length) {
      flip = false;
      const p = s.projects.get(P);
      p.archivedAt = new Date(s.now());
      p.purgeAfter = new Date(s.now());
    }
    return counts(id);
  };
  await s.job.tick();
  const [stop] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.ok(stop, "the stop card slipped in for the old archive");
  assert.equal(cardArchive(stop), new Date(T0 - 31 * DAY).toISOString(), "it names the archive it was built for");
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(stop.id)).status, "expired", "the tick's first pass closes it");
  const pending = await s.purgeCards("pending");
  assert.equal(pending.length, 1, "the current archive gets its purge card");
  assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString());

  // B: a stop owed (its write failed) for an archive that then ended is dropped, never raised, and holds nothing back.
  const t = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await t.job.tick();
  const [d] = await t.purgeCards("pending");
  await t.approvals.approve(t.session, d.id, { confirmation: `PURGE project:${P}` });
  t.failRaise.n = 1;
  await t.job.tick();
  assert.equal((await t.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "the stop write failed; it is owed");
  const q = t.projects.get(P);
  t.advance(60_000);
  q.archivedAt = new Date(t.now());
  q.purgeAfter = new Date(t.now());
  t.advance(DAY);
  await t.job.tick();
  assert.equal((await t.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "an ended archive's stop is never raised");
  assert.ok(t.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "archive-superseded"));
  const fresh = await t.purgeCards("pending");
  assert.equal(fresh.length, 1);
  assert.equal(cardArchive(fresh[0]), q.archivedAt.toISOString());

  // C: a stop card of this same archive still blocks the next purge card, and is left open.
  const u = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await u.job.tick();
  const [e] = await u.purgeCards("pending");
  await u.approvals.approve(u.session, e.id, { confirmation: `PURGE project:${P}` });
  await u.job.tick();
  u.advance(DAY);
  await u.job.tick();
  const [ustop] = await u.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(ustop.status, "pending");
  assert.equal((await u.purgeCards("pending")).length, 0);
});

test("M2.5-b5 decision 19 (Codex PR240-r15): a stop raise deduplicated onto an earlier archive's pending stop card still delivers this archive's stop", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const old = { id: P, slug: "acme", archivedAt: new Date(T0 - 60 * DAY) };
  const purge = s.job.d.purge;
  let stale;
  s.job.d.purge = async (...a) => {
    // An earlier archive's stop card slipped in (decision 18) after this tick's first pass.
    stale = await s.approvals.raiseCard(purgeStoppedCard(old, "leftover", { github: 1 }));
    return purge(...a);
  };
  await s.job.tick();
  assert.equal((await s.approvals.store.get(stale.id)).status, "expired", "the stale twin is closed");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), s.projects.get(P).archivedAt.toISOString(), "this archive's stop reaches KK");
  assert.match(pending[0].reason, /a DevOS rule does not allow this purge/);
  // And it keeps holding back the next purge card.
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
});

test("M2.5-b5 decision 20 (Codex PR240-r16): a stop raise deduplicated onto a newer archive's stop card never expires it, and the ended archive's stop is dropped", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const counts = s.job.d.activeCounts;
  let newer = null;
  s.job.d.activeCounts = async (id) => {
    if (!newer && (await s.approvals.store.list({ action: PURGE_ACTION, status: "approved", limit: 5 })).length) {
      // After deliverStops' re-read: Restore, a new Archive, and another process's stop card for that new archive.
      const p = s.projects.get(P);
      p.archivedAt = new Date(s.now());
      newer = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }));
    }
    return counts(id);
  };
  await s.job.tick();
  assert.ok(newer);
  assert.equal((await s.approvals.store.get(newer.id)).status, "pending", "the newer archive's stop card is left alone");
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(stops.length, 1, "no stop is written for the ended archive");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "archive-superseded"));
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(newer.id)).status, "pending", "still open on the next tick");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("M2.5-b5 decision 21 (Codex PR240-r17): an older delivery never clears a newer archive's owed stop", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  s.failRaise.n = 1;
  await s.job.tick();
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "the old archive's stop is owed");
  // Restore and a new Archive; the old delivery's re-read is slow, and meanwhile a late purge owes the new archive's stop.
  const p = s.projects.get(P);
  s.advance(60_000);
  p.archivedAt = new Date(s.now());
  const read = s.job.d.project;
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  s.job.d.project = async (id) => { if (first) { first = false; await gate; } return read(id); };
  const tick = s.job.tick();
  await new Promise((r) => setImmediate(r));
  s.failRaise.n = 1;
  const late = s.job.raiseStopped({ ...p }, "leftover");
  release();
  await Promise.all([tick, late]);
  s.job.d.project = read;
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  s.advance(60_000);
  await s.job.tick();
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(stops.length, 1, "the new archive's stop is still delivered");
  assert.equal(cardArchive(stops[0]), p.archivedAt.toISOString());
  assert.match(stops[0].reason, /the leftover check still found resources of this project/);
});

test("M2.5-b5 decision 22 (Codex PR240-r18): a late stop for an older archive never replaces the newer archive's owed stop", async () => {
  const s = setup();
  const p = s.projects.get(P);
  const older = { ...p };
  s.advance(60_000);
  p.archivedAt = new Date(s.now());
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "leftover");
  s.failRaise.n = 1;
  await s.job.raiseStopped(older, "policy_denied");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "archive-superseded"));
  await s.job.tick();
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(stops.length, 1, "the newer archive's stop is delivered");
  assert.equal(cardArchive(stops[0]), p.archivedAt.toISOString());
  assert.match(stops[0].reason, /the leftover check still found resources of this project/);
});

test("M2.5-b5 decision 36 (Codex PR240-r32, amended by decision 41): a stop that must be reported, deduplicated onto this archive's pending stop for another failure, supersedes it, so KK sees the new failure", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("ownership_mismatch", false, "not ours"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const p = s.projects.get(P);
  const purge = s.job.d.purge;
  let earlier;
  s.job.d.purge = async (...a) => {
    // An earlier, unanswered stop for this same archive but another failure is still pending when this one is raised.
    earlier = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }));
    return purge(...a);
  };
  await s.job.tick();
  const prior = await s.approvals.store.get(earlier.id);
  assert.equal(prior.status, "expired", "the earlier failure's stop is superseded");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), p.archivedAt.toISOString());
  assert.equal(stopWhy(pending[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it", "the new failure reaches KK");
  // It still holds back the next purge card, and a second tick changes nothing.
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 })).length, 1);
});

test("M2.5-b5 decision 41 (Codex PR240-r37): a scheduled card's denial deduplicated onto this archive's pending stop keeps that stop, through the real purge path", async () => {
  const s = setup({ purgeImpl: async () => { throw new TeardownError("policy_denied", false, "denied"); } });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const p = s.projects.get(P);
  const purge = s.job.d.purge;
  let earlier;
  s.job.d.purge = async (...a) => {
    // An earlier, unanswered report for this same archive but another failure is still pending when this one is raised.
    earlier = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }));
    return purge(...a);
  };
  await s.job.tick();
  const prior = await s.approvals.store.get(earlier.id);
  assert.equal(prior.status, "pending", "the earlier report is kept");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(cardArchive(pending[0]), p.archivedAt.toISOString());
  assert.equal(stopWhy(pending[0].reason), "after deleting, the leftover check still found resources of this project", "the earlier report still reaches KK");
  // It still holds back the next purge card, and a second tick changes nothing.
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 })).length, 1);
});

test("M2.5-b5 decision 36 (Codex PR240-r32): a twin with this archive and this failure serves the stop and is kept", async () => {
  const s = setup();
  const p = s.projects.get(P);
  // Decision 45 (Codex PR240-r41): the twin is stamped at the stop's own time; an unstamped twin predates it and is
  // superseded instead (covered by the decision 45 tests).
  const twin = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 9 }, new Date(s.now())));
  await s.job.raiseStopped({ ...p }, "leftover");
  assert.equal((await s.approvals.store.get(twin.id)).status, "pending");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("M2.5-b5 decision 36 (Codex PR240-r32): stopWhy reads the fixed failure text of every stop card", () => {
  const at = new Date(T0);
  for (const code of ["leftover", "policy_denied", "scan-error", "no-such-code"]) {
    const card = purgeStoppedCard({ id: P, slug: "acme", archivedAt: at }, code, { github: 1 });
    assert.ok(stopWhy(card.reason), code);
    assert.ok(card.reason.includes(`stopped: ${stopWhy(card.reason)}. `), code);
  }
  assert.equal(stopWhy(purgeStoppedCard({ id: P, slug: "BAD SLUG", archivedAt: at }, "leftover", {}).reason), "after deleting, the leftover check still found resources of this project");
  assert.notEqual(stopWhy(purgeStoppedCard({ id: P, slug: "acme", archivedAt: at }, "leftover", {}).reason), stopWhy(purgeStoppedCard({ id: P, slug: "acme", archivedAt: at }, "incomplete", {}).reason));
});

async function rejectedOthers(s, n, prefix) {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${String(i).padStart(12, "0")}`;
    const at = new Date(s.now() - 40 * DAY);
    // Rejections that no longer apply (the projects were restored), all newer than P's.
    s.projects.set(id, { id, slug: `p${i}`, stage: "active", archivedAt: null, purgeAfter: null });
    const r = await s.approvals.raiseCard(purgeCard({ id, slug: `p${i}`, archivedAt: at }, { github: 1 }));
    await s.approvals.reject(s.session, r.id ?? r);
  }
}

test("M2.5-b5 decision 36 (Codex PR240-r32): Keep archived pages past a full page of newer rejections to an older one that still applies", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(1);
  await s.approvals.reject(s.session, c.id);
  const decidedAt = s.now();
  s.advance(1);
  await rejectedOthers(s, CARD_PAGE + 5, "77777777-7777-4777-8777");
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "the older rejection is reached");
  assert.equal(s.calls.keep[0].approvalId, c.id);
  assert.equal(s.projects.get(P).purgeAfter.getTime(), decidedAt + KEEP_ARCHIVED_MS);
});

test("M2.5-b5 decision 36 (Codex PR240-r32): a Keep archived scan that stops at its bound resumes on the next tick", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(1);
  await s.approvals.reject(s.session, c.id);
  s.advance(1);
  await rejectedOthers(s, CLEANUP_SCAN_MAX + 5, "88888888-8888-4888-8888");
  const read = s.job.d.project;
  let reads = 0;
  s.job.d.project = async (id) => { reads++; return read(id); };
  await s.job.tick();
  assert.equal(s.calls.keep.length, 0, "the first scan stops at its bound");
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "the next tick resumes and moves the date");
  assert.equal(s.calls.keep[0].approvalId, c.id);
  assert.ok(reads > 0);
});

test("M2.5-b5 decision 37 (Codex PR240-r33): an older stop's delivery never supersedes the newer failure's card for the same archive", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "policy_denied");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "the earlier stop is owed");
  // The earlier stop's delivery is slow at its re-read; meanwhile a timed-out purge finishes with a newer failure.
  const read = s.job.d.project;
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  s.job.d.project = async (id) => { if (first) { first = false; await gate; } return read(id); };
  const tick = s.job.tick();
  await new Promise((r) => setImmediate(r));
  s.advance(60_000);
  // Decision 39: the newer stop's delivery queues behind the paused one, never interleaves with it.
  const late = s.job.raiseStopped({ ...p }, "leftover");
  await new Promise((r) => setImmediate(r));
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "nothing is written while the older delivery is paused");
  release();
  await Promise.all([tick, late]);
  s.job.d.project = read;
  const [newer] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(stopWhy(newer.reason), "after deleting, the leftover check still found resources of this project");
  assert.equal((await s.approvals.store.get(newer.id)).status, "pending", "the newer failure's card is left open");
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(stops.length, 1, "the older failure is not raised over it");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stop-superseded"));
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(newer.id)).status, "pending");
});

test("M2.5-b5 decision 38 (Codex PR240-r34): an older delivery whose entry was replaced writes nothing, so the newer failure is delivered", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "policy_denied");
  const counts = s.job.d.activeCounts;
  const gates = [];
  s.job.d.activeCounts = async (id) => { await new Promise((r) => gates.push(r)); return counts(id); };
  // The older delivery pauses in activeCounts; a newer failure replaces its entry and pauses in its own delivery.
  const tick = s.job.tick();
  await new Promise((r) => setImmediate(r));
  s.advance(60_000);
  const late = s.job.raiseStopped({ ...p }, "leftover");
  await new Promise((r) => setImmediate(r));
  // Decision 39: the newer delivery is queued behind the paused one, so only one is in activeCounts.
  assert.equal(gates.length, 1);
  s.advance(60_000);
  gates[0]();
  while (gates.length < 2) await new Promise((r) => setImmediate(r));
  gates[1]();
  await Promise.all([tick, late]);
  s.job.d.activeCounts = counts;
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "after deleting, the leftover check still found resources of this project", "the newer failure reaches KK");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1, "the older failure wrote nothing");
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 }))[0].id, pending[0].id);
});

test("M2.5-b5 decision 39 (Codex PR240-r35): a newer stop raised while an older delivery's expiry is in flight is still delivered", async () => {
  const s = setup();
  const p = s.projects.get(P);
  // A pending card for failure A, then a stop for failure B is owed (its first raise failed).
  const a = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }));
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  // Decision 51: the supersede (expiry and raise in one transaction) is where the delivery pauses.
  const supersede = s.job.d.supersede;
  let release;
  const gate = new Promise((r) => (release = r));
  let paused = false;
  s.job.d.supersede = async (oldId, c, reason) => {
    if (reason === "stop-card-superseded" && !paused) { paused = true; await gate; }
    return supersede(oldId, c, reason);
  };
  // B's delivery deduplicates onto A's card and starts superseding it; a newer stop for failure A arrives meanwhile.
  const tick = s.job.tick();
  while (!paused) await new Promise((r) => setImmediate(r));
  s.advance(60_000);
  const late = s.job.raiseStopped({ ...p }, "leftover");
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([tick, late]);
  s.job.d.supersede = supersede;
  assert.equal((await s.approvals.store.get(a.id)).status, "expired");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1, "KK has a card for the newest failure");
  assert.equal(stopWhy(pending[0].reason), "after deleting, the leftover check still found resources of this project");
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 }))[0].id, pending[0].id);
});

test("M2.5-b5 decision 40 (Codex PR240-r36): a droppable denial never replaces an owed stop that must be reported", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "the partial purge's report is owed");
  // A later scheduled approval is denied because Keep archived moved its date; its handler used an old snapshot.
  await s.job.raiseStopped({ ...p }, "policy_denied", new Date(p.purgeAfter.getTime() - DAY).toISOString());
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stop-owed-kept"));
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1, "KK still gets the partial purge's report");
  assert.equal(stopWhy(pending[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it");
});

test("M2.5-b5 decision 41 (Codex PR240-r37): a droppable denial never supersedes a pending report of a partial purge", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  const [report] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.ok(report, "the partial purge's report was raised, so it is no longer owed");
  // A later scheduled approval for the current date is denied before any deletion.
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "policy_denied", p.purgeAfter.toISOString());
  assert.equal((await s.approvals.store.get(report.id)).status, "pending", "the report is not expired");
  const stops = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 });
  assert.equal(stops.length, 1, "the denial raises no card over it");
  assert.equal(stopWhy(stops[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stop-pending-kept"));
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(report.id)).status, "pending");
});

test("M2.5-b5 decision 42 (Codex PR240-r38): an early ask's denial (no due date) never replaces an owed report of a partial purge", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "policy_denied");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stop-owed-kept"));
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it");
});

test("M2.5-b5 decision 42 (Codex PR240-r38): an early ask's denial (no due date) never supersedes a pending report of a partial purge", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  const [report] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "approval_required");
  assert.equal((await s.approvals.store.get(report.id)).status, "pending");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "stop-pending-kept"));
});

test("M2.5-b5 decision 42 (Codex PR240-r38): a newer denial still supersedes a pending older denial of the same archive", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "approval_required");
  const [old] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "policy_denied");
  assert.equal((await s.approvals.store.get(old.id)).status, "expired");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "a DevOS rule does not allow this purge");
});

test("M2.5-b5 decision 42 (Codex PR240-r38): an older delivery never expires a newer failure's card that another sweep instance raised", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "leftover");
  const olderAt = s.now();
  const counts = s.job.d.activeCounts;
  let release;
  const gate = new Promise((r) => (release = r));
  let paused = false;
  s.job.d.activeCounts = async (id) => { paused = true; await gate; return counts(id); };
  // The older delivery pauses after its archive read; another instance raises a newer failure's card meanwhile.
  const tick = s.job.tick();
  while (!paused) await new Promise((r) => setImmediate(r));
  s.advance(60_000);
  const newer = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "ownership_mismatch", { github: 1 }, new Date(s.now())));
  release();
  await tick;
  s.job.d.activeCounts = counts;
  assert.ok(stopAt(newer.reason) > olderAt);
  // Decision 46 (Codex PR240-r42): stamps from separate clocks cannot order two failures, so neither is dropped: the
  // newer card is superseded by one that names both failures and keeps the later stamp.
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.deepEqual(new Set(stopWhys(pending[0].reason)), new Set(stopWhys(newer.reason).concat(stopWhy(purgeStoppedCard(p, "leftover", {}).reason))), "the pending card names both failures");
  assert.equal(stopAt(pending[0].reason), stopAt(newer.reason), "the later stamp is kept");
});

test("M2.5-b5 decision 42 (Codex PR240-r38): a stop card stamps when it stopped before its archive stamp; denials are the authorizer's codes", () => {
  const at = new Date("2026-11-26T00:10:00.000Z");
  const archivedAt = new Date("2026-10-01T00:00:00.000Z");
  const c = purgeStoppedCard({ id: P, slug: "acme", archivedAt }, "leftover", { github: 1 }, at);
  assert.equal(stopAt(c.reason), at.getTime());
  assert.equal(cardArchive(c), archivedAt.toISOString());
  assert.equal(stopAt(purgeStoppedCard({ id: P, slug: "acme", archivedAt }, "leftover", {}).reason), null);
  assert.equal(stopAt(purgeStoppedCard({ id: P, slug: "acme", archivedAt: null }, "leftover", {}, at).reason), at.getTime());
  assert.deepEqual(["policy_denied", "approval_required", "ownership_mismatch", "leftover"].map(beforeDeletion), [true, true, false, false]);
});

test("M2.5-b5 decision 43 (Codex PR240-r39): an owed report of a partial purge supersedes a later denial's card another instance raised", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  s.advance(60_000);
  const denial = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "approval_required", { github: 1 }, new Date(s.now())));
  s.advance(60_000);
  await s.job.tick();
  assert.equal((await s.approvals.store.get(denial.id)).status, "expired", "the later denial does not stand in for the report");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it");
});

test("M2.5-b5 decision 43 (Codex PR240-r39): a stop is raised and superseded only under the project's lifecycle lock", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }));
  let inLock = false;
  const writes = [];
  const raise = s.job.d.raise;
  const supersede = s.job.d.supersede;
  s.job.d.raise = async (c) => { writes.push(["raise", inLock]); return raise(c); };
  s.job.d.supersede = async (id, c, r) => { writes.push(["supersede", inLock]); return supersede(id, c, r); };
  const held = [];
  s.job.d.lockHeld = async (id) => { held.push(id); };
  s.job.d.locked = async (id, fn) => { assert.equal(id, P); inLock = true; try { return await fn(); } finally { inLock = false; } };
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "ownership_mismatch");
  // Decision 51: the expiry and the replacement raise are one write (`supersede`).
  assert.deepEqual(writes, [["raise", true], ["supersede", true]]);
  assert.equal(held.length, 2, "the lock is checked before each write");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(stopWhy(pending[0].reason), "DevOS could not prove that it owns one of the project's resources, so it did not delete it");
});

test("M2.5-b5 decision 43 (Codex PR240-r39): a stop whose lock cannot be taken stays owed and is delivered on a later tick", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.job.d.locked = async () => { throw new Error("lock_timeout"); };
  await s.job.raiseStopped({ ...p }, "leftover");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.code === "leftover"));
  s.job.d.locked = async (id, fn) => fn();
  s.advance(60_000);
  await s.job.tick();
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "after deleting, the leftover check still found resources of this project");
});

test("M2.5-b5 decision 44 (Codex PR240-r40): a denial's stop is read again under the lock, so a date Keep archived moved meanwhile drops it", async () => {
  const s = setup();
  const p = s.projects.get(P);
  const due = p.purgeAfter.toISOString();
  // Keep archived holds the lock and moves the date while this delivery waits for it.
  s.job.d.locked = async (id, fn) => {
    const row = s.projects.get(id);
    s.projects.set(id, { ...row, purgeAfter: new Date(row.purgeAfter.getTime() + 30 * DAY) });
    return fn();
  };
  await s.job.raiseStopped({ ...p }, "policy_denied", due);
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0, "no stop card for the moved date");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-skipped" && l.code === "purge-card-not-due"));
});

test("M2.5-b5 decision 40 (Codex PR240-r36): a stop that must be reported still replaces an owed droppable denial", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "policy_denied", p.purgeAfter.toISOString());
  await s.job.raiseStopped({ ...p }, "leftover");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), "after deleting, the leftover check still found resources of this project");
});

test("M2.5-b5 decision 45 (Codex PR240-r41): a newer report of the same failure advances the stored stamp, so an older failure owed by another instance never hides it", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "ownership_mismatch"); // failure A at t1, delivered
  const [first] = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  s.advance(60_000);
  // Another sweep instance owes failure B at t2; its first delivery fails, so it stays owed there.
  const other = new TeardownSweepJob({ ...s.job.d });
  s.failRaise.n = 1;
  await other.raiseStopped({ ...p }, "leftover");
  s.advance(60_000);
  const t3 = s.now();
  await s.job.raiseStopped({ ...p }, "ownership_mismatch"); // failure A again at t3
  assert.equal((await s.approvals.store.get(first.id)).status, "expired", "the t1 report is superseded by the t3 one");
  let pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopAt(pending[0].reason), t3, "the stored stamp advanced to the newest report");
  await other.tick(); // B (t2) finds A stamped t3: one card names both (decision 46) and keeps the t3 stamp
  pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.ok(stopWhys(pending[0].reason).includes("DevOS could not prove that it owns one of the project's resources, so it did not delete it"), "the newest failure A is still reported");
  assert.ok(stopWhys(pending[0].reason).includes("after deleting, the leftover check still found resources of this project"));
  assert.equal(stopAt(pending[0].reason), t3);
});

test("M2.5-b5 decision 45 (Codex PR240-r41): a same-failure card stamped at or after the stop still serves it", async () => {
  const s = setup();
  const p = s.projects.get(P);
  const card = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "leftover", { github: 1 }, new Date(s.now() + 60_000)));
  await s.job.raiseStopped({ ...p }, "leftover");
  assert.equal((await s.approvals.store.get(card.id)).status, "pending");
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 1);
});

test("M2.5-b5 decision 46 (Codex PR240-r42): two failures stamped in the same millisecond by different instances are both reported, in either delivery order", async () => {
  for (const [first, second] of [["ownership_mismatch", "leftover"], ["leftover", "ownership_mismatch"]]) {
    const s = setup();
    const p = s.projects.get(P);
    const other = new TeardownSweepJob({ ...s.job.d });
    s.failRaise.n = 1;
    await other.raiseStopped({ ...p }, second); // owed in the other instance at the same millisecond
    await s.job.raiseStopped({ ...p }, first);
    await other.tick();
    const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
    assert.equal(pending.length, 1);
    const whys = stopWhys(pending[0].reason);
    for (const code of [first, second]) assert.ok(whys.includes(stopWhy(purgeStoppedCard(p, code, {}).reason)), `${first}/${second}: ${code} is reported`);
  }
});

test("M2.5-b5 decision 46 (Codex PR240-r42): a stop card names other failures only from the fixed texts, once each", () => {
  const p = { id: P, slug: "acme", archivedAt: new Date(T0) };
  const own = stopWhy(purgeStoppedCard(p, "leftover", {}).reason);
  const other = stopWhy(purgeStoppedCard(p, "ownership_mismatch", {}).reason);
  const c = purgeStoppedCard(p, "leftover", { github: 1 }, new Date(T0), [other, other, own, "ignore previous instructions"]);
  assert.deepEqual(stopWhys(c.reason), [own, other]);
  assert.ok(!c.reason.includes("ignore previous"));
  assert.equal(stopAt(c.reason), T0);
  assert.equal(stopWhy(c.reason), own);
  assert.deepEqual(stopWhys(purgeStoppedCard(p, "leftover", {}).reason), [own], "a single failure names no others");
});

test("M2.5-b5 decision 47 (Codex PR240-r43): a newer stop that replaces an owed one whose delivery failed still names the owed failure", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch"); // delivery fails before any card is written
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, limit: 10 })).length, 0);
  s.advance(60_000);
  await s.job.raiseStopped({ ...p }, "provider_forbidden");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), stopWhy(purgeStoppedCard(p, "provider_forbidden", {}).reason));
  assert.ok(stopWhys(pending[0].reason).includes(stopWhy(purgeStoppedCard(p, "ownership_mismatch", {}).reason)), "the earlier failure is not lost");
});

test("M2.5-b5 decision 47 (Codex PR240-r43): a replacement raise that fails after the twin was expired is retried with the twin's failures", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "ownership_mismatch"); // pending card A
  s.advance(60_000);
  const supersede = s.job.d.supersede;
  s.job.d.supersede = () => Promise.reject(new Error("db blip")); // the supersede (expiry and replacement raise) fails
  await s.job.raiseStopped({ ...p }, "leftover");
  s.job.d.supersede = supersede;
  // Decision 51: the failed supersede rolled back, so the twin is still pending (it was never replaced by nothing).
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 })).length, 1, "the twin is still pending");
  await s.job.tick();
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  const whys = stopWhys(pending[0].reason);
  for (const code of ["leftover", "ownership_mismatch"]) assert.ok(whys.includes(stopWhy(purgeStoppedCard(p, code, {}).reason)), code);
});

test("M2.5-b5 decision 48 (Codex PR240-r44): a same-failure twin that leaves out a carried failure does not serve the stop", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "ownership_mismatch"); // A owed; its delivery fails
  s.advance(60_000);
  // Another instance raised B, stamped later, without A.
  const twin = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "provider_forbidden", { github: 1 }, new Date(s.now() + 60_000)));
  await s.job.raiseStopped({ ...p }, "provider_forbidden"); // B replaces A here, carrying it (decision 47)
  assert.equal((await s.approvals.store.get(twin.id)).status, "expired", "the twin without A is superseded");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  const whys = stopWhys(pending[0].reason);
  for (const code of ["provider_forbidden", "ownership_mismatch"]) assert.ok(whys.includes(stopWhy(purgeStoppedCard(p, code, {}).reason)), code);
  assert.equal(stopAt(pending[0].reason), stopAt(twin.reason), "the later stamp is kept");
});

test("M2.5-b5 decision 49 (Codex PR240-r45): a current approval below a full page of approvals that can no longer run still purges", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  s.advance(5 * 60_000);
  const cards = s.job.d.cards;
  // A newest page of approved cards whose grants are spent sits above KK's current approval.
  const stale = Array.from({ length: CARD_PAGE }, (_, i) => ({ ...c, id: `stale-${i}`, status: "approved" }));
  s.job.d.cards = async (f) => {
    if (f.status !== "approved") return cards(f);
    if (!f.cursor) return stale.slice(0, f.limit);
    if (f.cursor === stale[stale.length - 1].id) return cards({ ...f, cursor: undefined });
    return [];
  };
  await s.job.tick();
  s.job.d.cards = cards;
  assert.equal(s.calls.purge.length, 1, "the current approval is reached on a later page");
});

test("M2.5-b5 decision 49 (Codex PR240-r45): a scheduled denial that replaces an owed early-ask denial is not dropped when the date moves", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 2;
  await s.job.raiseStopped({ ...p }, "approval_required"); // early ask: no due date; delivery fails
  await s.job.raiseStopped({ ...p }, "policy_denied", p.purgeAfter.toISOString()); // scheduled: due date; delivery fails
  p.purgeAfter = new Date(p.purgeAfter.getTime() + 30 * DAY); // Keep archived moves the date
  await s.job.tick(); // the owed stop is delivered on the next tick
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1, "the merged stop is still delivered");
  assert.ok(stopWhys(pending[0].reason).includes(stopWhy(purgeStoppedCard(p, "approval_required", {}).reason)), "the early ask's denial is kept");
});

test("M2.5-b5 decision 50 (Codex PR240-r46): a scheduled denial that absorbs a pending early-ask denial keeps both when the replacement raise fails and the date moves", async () => {
  const s = setup();
  const p = s.projects.get(P);
  await s.job.raiseStopped({ ...p }, "approval_required"); // early ask: pending card, no due date
  assert.equal((await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 })).length, 1);
  s.advance(60_000);
  const supersede = s.job.d.supersede;
  s.job.d.supersede = () => Promise.reject(new Error("db blip")); // the supersede fails
  await s.job.raiseStopped({ ...p }, "policy_denied", p.purgeAfter.toISOString()); // scheduled denial merges the twin
  s.job.d.supersede = supersede;
  p.purgeAfter = new Date(p.purgeAfter.getTime() + 30 * DAY); // Keep archived moves the date
  await s.job.tick();
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1, "the merged stop is still delivered");
  const whys = stopWhys(pending[0].reason);
  for (const code of ["policy_denied", "approval_required"]) assert.ok(whys.includes(stopWhy(purgeStoppedCard(p, code, {}).reason)), code);
});

test("M2.5-b5 decision 51 (Codex PR240-r47): a supersede that fails after its expiry leaves the pending stop card in place", async () => {
  const s = setup();
  const p = s.projects.get(P);
  const twin = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "ownership_mismatch", { github: 1 }));
  s.advance(60_000);
  // The store expires the twin, then the replacement raise fails inside the same step (a crash or a db blip).
  const store = s.approvals.store;
  const raiseNow = store.raiseNow;
  let n = 0;
  store.raiseNow = function (...a) { if (++n === 2) throw new Error("db blip"); return raiseNow.apply(this, a); }; // the supersede's raise
  await s.job.raiseStopped({ ...p }, "leftover");
  store.raiseNow = raiseNow;
  assert.equal(n, 2, "the supersede ran and its raise failed");
  assert.equal((await store.get(twin.id)).status, "pending", "KK's earlier report is still pending");
  await s.job.tick(); // the owed stop is delivered: one card names both failures
  const pending = await store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  const whys = stopWhys(pending[0].reason);
  for (const code of ["leftover", "ownership_mismatch"]) assert.ok(whys.includes(stopWhy(purgeStoppedCard(p, code, {}).reason)), code);
});

test("M2.5-b5 decision 52 (Codex PR240-r48): an older delivery whose entry is replaced during the lock probe writes nothing", async () => {
  const s = setup();
  const p = s.projects.get(P);
  s.failRaise.n = 1;
  await s.job.raiseStopped({ ...p }, "policy_denied"); // owed; its delivery failed
  const raise = s.job.d.raise;
  const raised = [];
  s.job.d.raise = (c) => { raised.push(stopWhy(c.reason)); return raise(c); };
  let late = null;
  s.job.d.lockHeld = async () => {
    // A timed-out purge's handler replaces the entry while the older delivery's probe is pending.
    if (!late) { s.advance(60_000); late = s.job.raiseStopped({ ...p }, "leftover"); }
  };
  await s.job.tick();
  await late;
  const denial = stopWhy(purgeStoppedCard(p, "policy_denied", {}).reason);
  assert.ok(!raised.includes(denial), "the obsolete stop was never raised");
  const pending = await s.approvals.store.list({ action: PURGE_STOPPED_ACTION, status: "pending", limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(stopWhy(pending[0].reason), stopWhy(purgeStoppedCard(p, "leftover", {}).reason));
  assert.ok(stopWhys(pending[0].reason).includes(denial), "the newer card still names the older failure (decision 47)");
});

test("M2.5-b5 decision 52 (Codex PR240-r48): an approval whose reads keep failing never holds back the approvals after it", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  s.advance(5 * 60_000);
  const cards = s.job.d.cards;
  const broken = { ...c, id: "broken-0", status: "approved" };
  s.job.d.cards = async (f) => {
    if (f.status !== "approved") return cards(f);
    const real = await cards({ ...f, cursor: undefined });
    return f.cursor ? [] : [broken, ...real].slice(0, f.limit);
  };
  const grant = s.job.d.unspentGrant;
  s.job.d.unspentGrant = (id, at) => (id === "broken-0" ? Promise.reject(new Error("db blip")) : grant(id, at));
  await s.job.tick();
  s.job.d.cards = cards;
  s.job.d.unspentGrant = grant;
  assert.equal(s.calls.purge.length, 1, "the current approval behind the failing one still purges");
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.approvalId === "broken-0"));
});

test("M2.5-b5 decision 53 (Codex PR240-r49): a project whose reads keep failing never holds back the other projects' cleanup", async () => {
  const s = setup();
  const Q = "88888888-8888-4888-8888-000000000001";
  const R = "88888888-8888-4888-8888-000000000002";
  const at = new Date(T0 - DAY);
  s.projects.set(Q, { id: Q, slug: "q", stage: "archived", archivedAt: at, purgeAfter: new Date(T0 + 29 * DAY) });
  s.projects.set(R, { id: R, slug: "r", stage: "archived", archivedAt: at, purgeAfter: new Date(T0 + 29 * DAY) });
  const restoredCard = await s.approvals.raiseCard(purgeCard({ id: Q, slug: "q", stage: "archived", archivedAt: at }, { github: 1 }));
  const endedStop = await s.approvals.raiseCard(purgeStoppedCard({ id: Q, slug: "q", archivedAt: new Date(T0 - 2 * DAY) }, "leftover", { github: 1 }));
  await s.approvals.raiseCard(purgeCard({ id: R, slug: "r", stage: "archived", archivedAt: at }, { github: 1 }));
  await s.approvals.raiseCard(purgeStoppedCard({ id: R, slug: "r", archivedAt: at }, "leftover", { github: 1 }));
  s.projects.get(Q).stage = "active"; // Q restored: both its cards are stale
  const project = s.job.d.project;
  s.job.d.project = (id) => (id === R ? Promise.reject(new Error("db blip")) : project(id));
  await s.job.tick();
  s.job.d.project = project;
  assert.equal((await s.approvals.store.get(restoredCard.id)).status, "expired", "the purge-card cleanup reached Q");
  assert.equal((await s.approvals.store.get(endedStop.id)).status, "expired", "the stop-card cleanup reached Q");
  assert.ok(s.logs.some((l) => l.msg === "teardown-card-failed" && l.projectId === R && l.code === "cleanup-read-failed"));
});

test("M2.5-b5 decision 53 (Codex PR240-r49): a stop card stamped with the current archive is kept even if it was written before the archive time", async () => {
  const s = setup();
  const p = s.projects.get(P);
  // The writing instance's clock runs behind: the card's creation time is before the project's archive time.
  p.archivedAt = new Date(s.now() + 60_000);
  const stop = await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "ownership_mismatch", { github: 1 }, new Date(s.now())));
  await s.job.tick();
  assert.equal((await s.approvals.store.get(stop.id)).status, "pending", "the current report stays with KK");
});

test("M2.5-b5 decision 54 (Codex PR240-r50): a current stop card written before the archive time still blocks a new purge card", async () => {
  const s = setup();
  const p = s.projects.get(P);
  // The writing instance's clock runs behind: the card's creation time is before the project's archive time.
  p.archivedAt = new Date(s.now() + 60_000);
  await s.approvals.raiseCard(purgeStoppedCard({ id: P, slug: "acme", archivedAt: p.archivedAt }, "ownership_mismatch", { github: 1 }, new Date(s.now())));
  s.advance(2 * 60_000);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0, "no new purge card while the report is with KK");
});

test("M2.5-b5 decision 54 (Codex PR240-r50): the approved-card pass never starts a second purge while this process's purge runs", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  const taken = [];
  const locked = s.job.d.locked;
  s.job.d.locked = (id, fn) => { taken.push(id); return locked ? locked(id, fn) : fn(); };
  s.job.purging.add(P);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 0, "no purge starts behind the running one");
  assert.deepEqual(taken, [], "no lock is queued");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-deferred" && l.approvalId === c.id && l.code === "purge-running"));
  s.job.purging.delete(P);
  s.advance(5 * 60_000);
  await s.job.tick();
  assert.equal(s.calls.purge.length, 1, "the approval purges once the earlier purge has ended");
});
