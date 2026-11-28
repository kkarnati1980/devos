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
  // M2.5-b5a: the guarded raise re-reads these rows (in Postgres: under the project lock, in the raise's transaction).
  store.guardRow = (id) => (projects.has(id) ? { ...projects.get(id) } : null);
  const hooks = { beforeLockedRaise: null };
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
    raiseLocked: async (c, g) => {
      if (hooks.beforeLockedRaise) await hooks.beforeLockedRaise(c);
      if (failRaise.n > 0) { failRaise.n--; throw new Error("db blip"); }
      return approvals.raiseGuardedCard(c, { projectId: c.projectId, ...g });
    },
    expire: (ids, reason) => approvals.expireCardsById(ids, reason),
    unspentGrant: async (approvalId, at) => {
      return [...policyStore.grants].find((g) => g.approvalId === approvalId && !g.revokedAt && g.expiresAt > at && g.uses === 0)?.id ?? null;
    },
    purge,
    // M2.5-b5b decision 3: the store's rule, on the job's clock (Postgres uses its own under the lifecycle lock).
    keepArchived: async (id, from, approvalId) => {
      const p = projects.get(id);
      if (!p || p.stage !== "archived" || p.purgeAfter?.getTime() !== from.getTime()) return null;
      const c = (await approvals.store.list({ status: "rejected", action: PURGE_ACTION, limit: 50 })).find((x) => x.id === approvalId);
      if (!c || c.projectId !== id || c.createdAt.getTime() < from.getTime() || (p.archivedAt && c.createdAt.getTime() < p.archivedAt.getTime())) return null;
      const to = new Date(Math.max(from.getTime(), now) + KEEP_ARCHIVED_MS);
      p.purgeAfter = to;
      calls.keep.push({ id, to, approvalId });
      return to;
    },
    log: (e) => logs.push(e),
    now: () => now,
    purgeTimeoutMs,
  });
  const session = kk.mint("kk@example.com");
  const purgeCards = (status) => approvals.store.list({ action: PURGE_ACTION, limit: 50, ...(status ? { status } : {}) });
  return { hooks, failDue, failRaise, job, approvals, store, engine, policyStore, projects, counts, calls, logs, session, purgeCards, advance: (ms) => (now += ms), now: () => now };
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
  const off = buildTeardownSweep({ ...mods, vault: { reveal: async () => null }, cards: { list: async () => [], raise: async () => ({}), raiseLocked: async () => ({ refused: "test" }), expire: async () => [] } });
  assert.ok("off" in off && typeof off.off === "string");
});

test("pre-review 6: the production queries: an unspent grant only, and Keep archived is conditional and audited", async () => {
  const seen = [];
  const tx = {
    approvalGrant: { findMany: async (q) => { seen.push(["grant", q]); return [{ id: "g1", uses: 0, maxUses: 1 }]; } },
    auditEvent: { create: async (q) => { seen.push(["audit", q]); return {}; } },
    $queryRawUnsafe: async (sql, ...args) => { seen.push(["lock", sql, args]); return [{ locked: 1 }]; },
    $queryRaw: async (strings, ...vals) => {
      const sql = strings.join("?");
      seen.push([sql.includes("UPDATE project") ? "update" : "raw", sql, vals]);
      return sql.includes("UPDATE project") ? [{ purgeAfter: new Date(T0 + KEEP_ARCHIVED_MS) }] : [{}];
    },
  };
  const db = { $transaction: async (fn, o) => { seen.push(["tx", o]); return fn(tx); } };
  class Store { project() { return null; } activeResources() { return []; } }
  const mod = { GitHubClient: class {}, CoolifyClient: class {} };
  const job = buildTeardownSweep({
    mod, td: { PrismaTeardownStore: Store }, db, databaseUrl: "postgresql://x", vault: { reveal: async () => null },
    policy: { decide: async () => ({ enforcedOutcome: "deny" }) }, cards: { list: async () => [], raise: async () => ({}), raiseLocked: async () => ({ refused: "test" }), expire: async () => [] },
    env: { DEVOS_GITHUB_OWNER: "acme", DEVOS_COOLIFY_URL: "https://coolify.example.com", DEVOS_COOLIFY_SERVER_UUID: "srv-1", DEVOS_TAILNET_IP: "100.64.0.7", GIT_SHA: "a".repeat(40) }, timeoutMs: 1000, log: () => {},
  });
  assert.ok(!("off" in job), JSON.stringify(job.off));
  const now = new Date(T0);
  assert.equal(await job.d.unspentGrant("a1", now), "g1");
  const g = seen.find((x) => x[0] === "grant")[1];
  assert.deepEqual(g.where, { approvalId: "a1", revokedAt: null, expiresAt: { gt: now }, uses: 0 });
  const from = new Date(T0), to = new Date(T0 + KEEP_ARCHIVED_MS);
  assert.deepEqual(await job.d.keepArchived(P, from, "a1"), to);
  // M2.5-b5b decision 3: the lifecycle lock first, then one conditional update on the database clock.
  const order = seen.filter((x) => x[0] === "lock" || x[0] === "update").map((x) => x[0]);
  assert.deepEqual(order, ["lock", "update"]);
  assert.deepEqual(seen.find((x) => x[0] === "lock")[2], [P]);
  const [, sql, vals] = seen.find((x) => x[0] === "update");
  for (const part of ["clock_timestamp()", "greatest(project.purge_after, n.t)", "project.stage = 'archived'", "project.purge_after = ?::timestamptz",
    "a.status = 'rejected'", "a.created_at >= project.purge_after", "a.created_at >= project.archived_at"]) assert.ok(sql.includes(part), part);
  assert.deepEqual(vals, [KEEP_ARCHIVED_MS, P, from, "a1"]);
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
    raiseLocked: async (c) => {
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

// M2.5-b5a (DEVOS-255, docs/modules/M2.5.md "M2.5-b5a"): the purge card is raised under the project's lifecycle lock on
// a fresh read of the row, so a purge, a Restore or a new Archive that lands after the caller's read gets no card.
test("M2.5-b5a AT1: an early ask whose row is purged before its locked raise answers not_archived and raises no card", async () => {
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + 10 * DAY);
  s.hooks.beforeLockedRaise = async () => { s.projects.get(P).stage = "purged"; };
  assert.deepEqual(await s.job.askPurge(P), { ok: false, code: "not_archived" });
  assert.equal((await s.purgeCards()).length, 0, "no card for a purged row");
  // Unchanged behaviour on an archived row: the ask raises its card.
  s.hooks.beforeLockedRaise = null;
  s.projects.get(P).stage = "archived";
  const r = await s.job.askPurge(P);
  assert.equal(r.ok, true);
  assert.equal(r.raised, true);
  assert.equal((await s.purgeCards("pending")).length, 1);
});

test("M2.5-b5a AT1: a failed locked raise raises nothing and is not reported as a card", async () => {
  const s = setup();
  s.projects.get(P).purgeAfter = new Date(T0 + 10 * DAY);
  s.failRaise.n = 1;
  await assert.rejects(() => s.job.askPurge(P));
  assert.equal((await s.purgeCards()).length, 0);
});

test("M2.5-b5a AT2: a daily run whose row is purged before its locked raise raises nothing", async () => {
  const s = setup();
  s.hooks.beforeLockedRaise = async () => { s.projects.get(P).stage = "purged"; };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-card-skipped" && l.code === "not_archived"));
});

test("M2.5-b5a AT3: a row restored and archived again after listDue gets no card from that run; the next day's run raises one", async () => {
  const s = setup();
  s.hooks.beforeLockedRaise = async () => {
    const p = s.projects.get(P);
    p.archivedAt = new Date(s.now());
    p.purgeAfter = new Date(s.now() - 1000); // already due, but a different archive than listDue returned
  };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0, "the stale due snapshot raises nothing");
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-card-skipped" && l.code === "archive-changed"));
  s.hooks.beforeLockedRaise = null;
  s.advance(DAY);
  await s.job.tick();
  assert.equal((await s.purgeCards("pending")).length, 1, "the new archive's own daily run raises its card");
});

test("M2.5-b5a AT3: Keep archived moving the purge date after listDue refuses the daily card (not-due)", async () => {
  const s = setup();
  s.hooks.beforeLockedRaise = async () => { s.projects.get(P).purgeAfter = new Date(s.now() + 30 * DAY); };
  await s.job.tick();
  assert.equal((await s.purgeCards()).length, 0);
  assert.ok(s.logs.some((l) => l.msg === "teardown-purge-card-skipped" && l.code === "not-due"));
});

test("M2.5-b5a: the daily run never queues behind this process's own running purge", async () => {
  let finish;
  const s = setup({ purgeImpl: () => new Promise((r) => { finish = r; }), purgeTimeoutMs: 5 });
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  await approve(s, c.id);
  s.advance(5 * 60_000);
  await s.job.tick(); // runs the purge; it times out at 5 ms and keeps running under the lock
  assert.equal(s.calls.providerCalls, 1);
  s.advance(DAY);
  let locked = 0;
  s.hooks.beforeLockedRaise = async () => { locked++; };
  await s.job.tick(); // the next day's run: the row is still archived and due, its purge still running
  assert.equal(locked, 0, "no locked raise while this process's purge is still running");
  assert.equal((await s.purgeCards("pending")).length, 0);
  finish({ purged: true, report: { hits: [], errors: [] } });
});

test("Codex PR242-r4/r5: a guarded card is dated by the app clock alone, and the due check uses that clock", async () => {
  const { guardRefusal, Approvals, MemoryApprovalStore } = await import("../dist/approvals.js");
  const archivedAt = new Date(T0 - 31 * DAY);
  const purgeAfter = new Date(T0 + 60_000); // 1 minute ahead of the app clock T0
  let row = { stage: "archived", archivedAt, purgeAfter };
  const g = { projectId: P, archivedAt, due: true };
  // One clock: at app time T0 this row is not yet due.
  assert.equal(guardRefusal(row, g, new Date(T0)), "not-due");
  assert.equal(guardRefusal(row, g, new Date(purgeAfter.getTime() + 1)), null);
  let appNow = purgeAfter.getTime() + 1;
  const store = new MemoryApprovalStore();
  store.guardRow = () => row;
  const ap = new Approvals({ store, grants: null, notifier: null, verifyKkSession: () => false, now: () => appNow });
  const P2 = "11111111-2222-4333-8444-666666666666";
  // A daily card raised just after purge_after on the app clock is dated after it: never floored at purge_after (r4).
  const daily = await ap.raiseGuardedCard(purgeCard({ id: P, slug: "acme" }, {}), g);
  assert.equal(daily.createdAt.getTime(), appNow);
  assert.ok(daily.createdAt.getTime() > purgeAfter.getTime());
  // r5: an app clock moved back behind archived_at dates the card by that clock, never floored at archived_at, so the
  // card cannot pass "raised this archive" for this archive or for a later one archived after that clock time.
  appNow = archivedAt.getTime() - DAY;
  row = { stage: "archived", archivedAt, purgeAfter: new Date(T0 + 10 * DAY) };
  const early = await ap.raiseGuardedCard(purgeCard({ id: P2, slug: "beta" }, {}), { projectId: P2, archivedAt, due: false });
  assert.equal(early.createdAt.getTime(), appNow, "no archived_at floor");
  assert.ok(early.createdAt.getTime() < archivedAt.getTime());
});

test("Codex PR242-r3 (2): an early ask whose project starts purging during its awaits never calls the locked raise", async () => {
  let finish;
  const s = setup({ purgeImpl: () => new Promise((r) => { finish = r; }), purgeTimeoutMs: 5 });
  s.projects.get(P).purgeAfter = new Date(T0 + 10 * DAY);
  const counts = s.job["d"].activeCounts;
  let locked = 0;
  s.hooks.beforeLockedRaise = async () => { locked++; };
  s.job["d"].activeCounts = async (id) => { s.job["purging"].add(id); return counts(id); };
  assert.deepEqual(await s.job.askPurge(P), { ok: false, code: "purge-already-approved" });
  assert.equal(locked, 0);
  assert.equal((await s.purgeCards()).length, 0);
  void finish;
});

test("Keep archived: one failing project does not stop the pass; a project being purged is skipped (M2.5-b5b decision 10)", async () => {
  const s = setup();
  await s.job.tick();
  const [c] = await s.purgeCards("pending");
  s.advance(2 * DAY);
  await s.approvals.reject(s.session, c.id);
  const real = s.job["d"].keepArchived;
  let fails = 1;
  s.job["d"].keepArchived = async (...a) => { if (fails-- > 0) throw new Error("lock_timeout"); return real(...a); };
  await s.job.tick();
  assert.ok(s.logs.some((e) => e.msg === "teardown-keep-archived-failed" && e.approvalId === c.id), "logged, not thrown");
  assert.ok(!s.logs.some((e) => e.msg === "teardown-keep-pass-failed"), "the pass itself did not fail");
  assert.equal(s.calls.keep.length, 0);
  // While this job purges the project, Keep archived does not wait on its lock.
  s.job["purging"].add(P);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 0);
  s.job["purging"].delete(P);
  await s.job.tick();
  assert.equal(s.calls.keep.length, 1, "retried on the next tick");
});
