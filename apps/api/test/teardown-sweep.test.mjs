// DEVOS-245 (M2.5-b2, docs/modules/M2.5.md "M2.5-b2 decisions"): the purge card and the teardown jobs, with the real
// M2.3 approvals core (memory store) and the real M1.7 engine issuing and checking the card's grant. AT3 through the
// jobs: no approved card → zero purge calls; the purge-due job only raises a card; Keep archived moves purge_after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { TeardownError } from "@devos/teardown";
import { KkSessionRegistry } from "../dist/auth.js";
import { Approvals, MemoryApprovalStore, parseCard } from "../dist/approvals.js";
import {
  TeardownSweepJob, purgeCard, purgeStoppedCard, countsText, istClock, withLimit, PurgeTimeout,
  PURGE_ACTION, PURGE_STOPPED_ACTION, KEEP_ARCHIVED_MS, PURGE_TIME_LIMIT_MS,
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
  const purge = async (projectId, grantId, cardCreatedAt) => {
    calls.purge.push({ projectId, grantId });
    // The real purge checks `teardown.purge` once before any provider call (M2.5-a1), with the production authorizer.
    const d = await purgeCardAuthorizer(engine, projectId, grantId, cardCreatedAt, async () => projects.get(projectId)?.archivedAt ?? null)("teardown.purge", `project:${projectId}`);
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
    unspentGrant: async (approvalId, at) => {
      return [...policyStore.grants].find((g) => g.approvalId === approvalId && !g.revokedAt && g.expiresAt > at && g.uses === 0)?.id ?? null;
    },
    purge,
    keepArchived: async (id, from, to, approvalId) => {
      const p = projects.get(id);
      if (!p || p.stage !== "archived" || p.purgeAfter?.getTime() !== from.getTime()) return false;
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
  assert.equal(await job.d.keepArchived(P, from, to, "a1"), true);
  assert.deepEqual(seen.find((x) => x[0] === "update")[1], { where: { id: P, stage: "archived", purgeAfter: from }, data: { purgeAfter: to } });
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

test("pre-review r2 2: the authorizer refuses a card older than archived_at, re-read when the purge asks", async () => {
  const s = setup();
  let archivedAt = new Date(T0);
  const auth = purgeCardAuthorizer(s.engine, P, "00000000-0000-4000-8000-0000000000ff", new Date(T0 - 1), async () => archivedAt);
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
  assert.equal(await auth("teardown.archive", `project:${P}`), "deny");
  archivedAt = null;
  assert.equal(await auth("teardown.purge", `project:${P}`), "deny");
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
  const approved = { id: "33333333-2222-4333-8444-555555555555", status: "approved", action: PURGE_ACTION, target: `project:${P}`, projectId: P, createdAt: new Date(T0 - DAY), decidedAt: new Date(T0 - DAY) };
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
