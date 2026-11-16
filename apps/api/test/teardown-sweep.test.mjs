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

test("decision 1: an unanswered card is re-raised once after it expires (7 days), then nothing happens", async () => {
  const s = setup();
  await s.job.tick();
  s.advance(8 * DAY);
  await s.approvals.expireCards();
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "re-raised once");
  s.advance(8 * DAY);
  await s.approvals.expireCards();
  await s.job.tick();
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 0);
  assert.equal((await s.purgeCards("expired")).length, 2);
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

