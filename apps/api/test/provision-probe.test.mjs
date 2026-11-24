// DEVOS-228 (M2.4-d3b, docs/modules/M2.4.md "Part 2"): the AT13 probe's phase machine, with fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeStep, inventoryDiff, inventoryIncomplete, probeProvisionOnce, ensureProbeProject, PrismaProbeLog, PROBE_SLUG, PROBE_EVERY_MS, PROBE_PHASE_MAX_MS } from "../dist/provision-probe.js";

const ROWS = [
  { key: "github_repo", provider: "github", externalId: "1", name: "devos-probe-m24" },
  { key: "coolify_project", provider: "coolify", externalId: "p-1", name: "devos-probe-m24" },
];

function fake(over = {}) {
  const log = [];
  const calls = { provision: 0, inventory: 0, asserts: 0, purge: 0 };
  let t = Date.parse("2026-11-16T00:00:00Z");
  const d = {
    log, calls,
    fingerprint: "fp-1",
    now: () => new Date(t),
    tick: (ms) => { t += ms; },
    offReason: async () => null,
    last: async () => log.at(-1) ?? null,
    record: async (r) => { log.push(structuredClone(r)); },
    provisionOnce: async () => { calls.provision++; return "done"; },
    inventory: async () => { calls.inventory++; return ROWS; },
    liveAsserts: async () => { calls.asserts++; return []; },
    purge: async () => { calls.purge++; return "done"; },
    ...over,
  };
  return d;
}

async function runToEnd(d, max = 20) {
  const ticks = [];
  for (let i = 0; i < max; i++) {
    const r = await probeStep(d);
    ticks.push(r);
    if (r.exit !== 3 || r.code === "skipped" || r.code === "probed") break;
  }
  return ticks;
}

test("a full cycle runs the phases in order, one per tick, and passes once", async () => {
  const d = fake();
  const ticks = await runToEnd(d);
  assert.deepEqual(ticks.map((t) => t.phase), ["run1", "inventory1", "run2", "inventory2", "assert", "purge", "done"]);
  assert.deepEqual(ticks.at(-1), { exit: 0, phase: "done", cycle: 1, code: "pass", detail: undefined });
  assert.deepEqual(d.calls, { provision: 2, inventory: 2, asserts: 1, purge: 1 });
  // later ticks within 7 days are skipped with the stored result, and nothing is called
  const again = await probeStep(d);
  assert.deepEqual(again, { exit: 3, phase: "done", cycle: 1, code: "probed", detail: "pass" });
  assert.deepEqual(d.calls, { provision: 2, inventory: 2, asserts: 1, purge: 1 });
});

test("skipped while the sweep is off: no record, no provider call", async () => {
  const d = fake({ offReason: async () => "provision-vault-not-configured" });
  const r = await probeStep(d);
  assert.equal(r.exit, 3);
  assert.equal(r.detail, "provision-vault-not-configured");
  assert.equal(d.log.length, 0);
  assert.equal(d.calls.provision, 0);
});

test("a run still in progress keeps its phase and is resumed next tick", async () => {
  let n = 0;
  const d = fake({ provisionOnce: async () => (++n === 1 ? "in_progress" : "done") });
  await probeStep(d); // the cycle starts
  const a = await probeStep(d);
  assert.deepEqual([a.exit, a.phase, a.code], [3, "run1", "in_progress"]);
  assert.equal(d.log.length, 1, "an unfinished run writes no row");
  const b = await probeStep(d);
  assert.equal(b.phase, "inventory1");
});

test("unequal inventories fail with the row named, after the purge", async () => {
  let n = 0;
  const d = fake({ inventory: async () => (++n === 1 ? ROWS : [ROWS[0], { ...ROWS[1], externalId: "p-2" }]) });
  const ticks = await runToEnd(d);
  const end = ticks.at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "inventory-differs", "differs:coolify_project"]);
  assert.equal(d.calls.purge, 1);
  assert.equal(d.calls.asserts, 0, "live asserts are skipped once the compare failed");
});

test("a failed live assert fails the cycle with its code, after the purge", async () => {
  const d = fake({ liveAsserts: async () => ["default-branch-not-main"] });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "live-assert-failed", "default-branch-not-main"]);
  assert.equal(d.calls.purge, 1);
});

test("a failed run purges what it created, then fails with the run's code", async () => {
  const d = fake({ provisionOnce: async () => ({ error: "provider_error" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "run1-failed", "provider_error"]);
  assert.equal(d.calls.purge, 1);
});

test("a refused purge fails with purge-failed and its code; nothing else is tried", async () => {
  const d = fake({ purge: async () => ({ error: "purge-permission" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "purge-failed", "purge-permission"]);
});

test("a new cycle starts after 7 days, or at once when the provisioning code changed", async () => {
  const d = fake();
  await runToEnd(d);
  d.tick(PROBE_EVERY_MS - 1);
  assert.equal((await probeStep(d)).code, "probed");
  d.tick(1);
  const r = await probeStep(d);
  assert.deepEqual([r.cycle, r.phase], [2, "run1"]);

  const e = fake();
  await runToEnd(e);
  e.fingerprint = "fp-2";
  const s = await probeStep(e);
  assert.deepEqual([s.cycle, s.phase], [2, "run1"]);
});

test("DEVOS-21: a failed cycle re-runs at once when a provider token was saved after it ended; a passed one waits", async () => {
  // Failed cycle (refused purge), then a token saved after it ended: the next tick starts cycle 2.
  let updated = null;
  let reads = 0;
  const d = fake({ purge: async () => ({ error: "purge-permission:preflight:github-counts" }), credentialsUpdatedAt: async () => { reads++; return updated; } });
  const end = (await runToEnd(d)).at(-1);
  assert.equal(end.code, "purge-failed");
  const endedAt = d.log.at(-1).at;
  assert.equal((await probeStep(d)).code, "probed", "no token update: not due");
  updated = endedAt;
  assert.equal((await probeStep(d)).code, "probed", "a token saved at the same moment is not newer");
  updated = new Date(Date.parse(endedAt) - 60_000).toISOString();
  assert.equal((await probeStep(d)).code, "probed", "a token saved before the cycle ended does not count");
  updated = "not-a-date";
  assert.equal((await probeStep(d)).code, "probed", "an unreadable time keeps the 7-day rule");
  d.tick(60_000);
  updated = d.now().toISOString();
  const r = await probeStep(d);
  assert.deepEqual([r.cycle, r.phase], [2, "run1"]);
  assert.equal(reads, 5, "one read per tick after the failed cycle ended");

  // A passed cycle never reads the tokens and waits the 7 days.
  let passReads = 0;
  const e = fake({ credentialsUpdatedAt: async () => { passReads++; return "2099-01-01T00:00:00.000Z"; } });
  await runToEnd(e);
  e.tick(60_000);
  assert.equal((await probeStep(e)).code, "probed");
  assert.equal(passReads, 0);

  // A throwing read keeps the 7-day rule; no dependency at all is the 7-day rule too.
  const f = fake({ purge: async () => ({ error: "purge-permission" }), credentialsUpdatedAt: async () => { throw new Error("vault down"); } });
  await runToEnd(f);
  assert.equal((await probeStep(f)).code, "probed");
  const g = fake({ purge: async () => ({ error: "purge-permission" }) });
  await runToEnd(g);
  assert.equal((await probeStep(g)).code, "probed");
  g.tick(PROBE_EVERY_MS);
  const h = await probeStep(g);
  assert.deepEqual([h.cycle, h.phase], [2, "run1"], "7 days on, the next cycle starts as before");
});

test("DEVOS-21: after a cleanup cycle whose purge passed, the real cycle starts on the next tick; a failed cleanup waits", async () => {
  let pending = true;
  const d = fake({ cycleStart: async () => (pending ? "purge-pending" : "ready") });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.cycle, end.exit, end.code], [1, 1, "previous-purge-pending"]);
  pending = false;
  const r = await probeStep(d);
  assert.deepEqual([r.cycle, r.phase], [2, "run1"]);
  const pass = (await runToEnd(d)).at(-1);
  assert.deepEqual([pass.cycle, pass.code], [2, "pass"]);
  assert.equal((await probeStep(d)).code, "probed", "a passed cycle waits the 7 days");

  const e = fake({ cycleStart: async () => "purge-pending", purge: async () => ({ error: "purge-permission" }) });
  const failed = (await runToEnd(e)).at(-1);
  assert.deepEqual([failed.code, failed.cause], ["purge-failed", "previous-purge-pending"]);
  assert.equal((await probeStep(e)).code, "probed", "a cleanup whose purge failed is not re-run at once");
});

test("inventoryDiff ignores row order and names a missing or extra row", () => {
  assert.equal(inventoryDiff(ROWS, [...ROWS].reverse()), null);
  assert.equal(inventoryDiff(ROWS, [ROWS[0]]), "missing-in-run2:coolify_project");
  assert.equal(inventoryDiff([ROWS[0]], ROWS), "extra-in-run2:coolify_project");
});

test("Codex PR164-r2: the same gap in both reads fails the cycle and names the row, after the purge", async () => {
  for (const [row, detail] of [
    [{ ...ROWS[1], name: "" }, "run1:no-active-resource:coolify_project"],
    [{ ...ROWS[1], externalId: "", name: "" }, "run1:no-external-id:coolify_project"],
  ]) {
    const d = fake({ inventory: async () => { d.calls.inventory++; return [ROWS[0], row]; } });
    const end = (await runToEnd(d)).at(-1);
    assert.deepEqual([end.exit, end.code, end.detail], [1, "inventory-incomplete", detail]);
    assert.equal(d.calls.inventory, 1, "the gap is caught on the first read; identical reads cannot pass");
    assert.equal(d.calls.purge, 1);
    assert.equal(d.calls.asserts, 0);
  }
});

test("Codex PR164-r2: a row lost between the reads is named from the second read", async () => {
  let n = 0;
  const d = fake({ inventory: async () => (++n === 1 ? ROWS : [ROWS[0], { ...ROWS[1], name: "" }]) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "inventory-incomplete", "run2:no-active-resource:coolify_project"]);
  assert.equal(d.calls.purge, 1);
});

test("inventoryIncomplete passes complete rows and names the first gap in key order", () => {
  assert.equal(inventoryIncomplete(ROWS), null);
  assert.equal(inventoryIncomplete([]), null);
  assert.equal(inventoryIncomplete([{ ...ROWS[0], externalId: "" }, { ...ROWS[1], name: "" }]), "no-active-resource:coolify_project");
});

test("inventoryDiff flags a key recorded twice in one run", () => {
  assert.equal(inventoryDiff([...ROWS, ROWS[0]], ROWS), "duplicate-in-run1:github_repo");
});

test("a run or purge in progress for longer than the phase limit ends the cycle as a timeout", async () => {
  const d = fake({ provisionOnce: async () => "in_progress" });
  await probeStep(d); // the cycle starts
  assert.equal((await probeStep(d)).code, "in_progress");
  d.tick(PROBE_PHASE_MAX_MS);
  const r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["purge", "in_progress"]);
  const end = await probeStep(d);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "run1-failed", "timeout"]);

  const e = fake({ purge: async () => "in_progress" });
  for (let i = 0; i < 6; i++) await probeStep(e); // start, run1 .. assert, now in purge
  assert.equal(e.log.at(-1).phase, "purge");
  e.tick(PROBE_PHASE_MAX_MS);
  const p = await probeStep(e);
  assert.deepEqual([p.exit, p.code, p.detail], [1, "purge-failed", "timeout"]);
});

const P = { id: "11111111-1111-4111-8111-111111111111", slug: "devos-probe-m24", name: "probe" };
const stop = (code, retryable) => Object.assign(new Error("provider said: secret-ish text"), { name: "StepError", code, retryable });

test("probeProvisionOnce: done, a missing token, a retryable stop, a final stop (fixed codes only)", async () => {
  const pv = (ready, run) => ({ ready: async () => ready, run });
  assert.equal(await probeProvisionOnce(pv(null, async () => ({})), P), "done");
  let ran = false;
  assert.deepEqual(await probeProvisionOnce(pv("provision-github-token-not-set", async () => { ran = true; }), P), { error: "provision-github-token-not-set" });
  assert.equal(ran, false, "nothing runs without both tokens");
  assert.equal(await probeProvisionOnce(pv(null, async () => { throw stop("provider_error", true); }), P), "in_progress");
  const r = await probeProvisionOnce(pv(null, async () => { throw stop("name_conflict", false); }), P);
  assert.deepEqual(r, { error: "name_conflict" });
  assert.equal(JSON.stringify(r).includes("secret-ish"), false);
  assert.equal(await probeProvisionOnce(pv(null, async () => { throw new Error("boom"); }), P), "in_progress");
});

test("pre-review M1: a throwing effect goes to the purge with a fixed code; a throwing purge ends at the limit", async () => {
  for (const [name, over] of [
    ["inventory1-failed", { inventory: async () => { throw new Error("502 from coolify: body"); } }],
    ["run1-failed", { provisionOnce: async () => { throw new Error("x"); } }],
    ["live-assert-failed", { liveAsserts: async () => { throw new Error("x"); } }],
  ]) {
    const d = fake(over);
    let end;
    for (let i = 0; i < 12; i++) { end = await probeStep(d); if (end.exit !== 3) break; d.tick(name === "run1-failed" ? PROBE_PHASE_MAX_MS : 1000); }
    assert.equal(end.exit, 1, name);
    assert.equal(end.code, name);
    assert.equal(d.calls.purge, 1, `${name}: the purge ran`);
    assert.equal(JSON.stringify(d.log).includes("coolify: body"), false, "no error text is stored");
  }
  const e = fake({ purge: async () => { throw new Error("x"); } });
  for (let i = 0; i < 7; i++) await probeStep(e);
  assert.equal(e.log.at(-1).phase, "purge", "a throwing purge stays in purge");
  e.tick(PROBE_PHASE_MAX_MS);
  const p = await probeStep(e);
  assert.deepEqual([p.exit, p.code], [1, "purge-failed"]);
});

test("pre-review L1: a purge failure keeps the earlier failure as its cause", async () => {
  let n = 0;
  const d = fake({ inventory: async () => (++n === 1 ? ROWS : [ROWS[0]]), purge: async () => ({ error: "purge-permission" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.code, end.detail], ["purge-failed", "purge-permission"]);
  assert.equal(d.log.at(-1).result.cause, "inventory-differs");
  // DEVOS-21 diagnostics: the earlier failure's detail is kept too, in the record and on the tick the check prints.
  assert.equal(d.log.at(-1).result.causeDetail, d.log.findLast((r) => r.phase === "purge" && r.result).result.detail);
  assert.equal(end.cause, "inventory-differs");
  assert.equal(end.causeDetail, d.log.at(-1).result.causeDetail);
});

test("DEVOS-21: a failed purge with no earlier failure has no cause on the tick or the record", async () => {
  const d = fake({ purge: async () => ({ error: "purge-permission:github/repo" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.code, end.detail, end.cause, end.causeDetail], ["purge-failed", "purge-permission:github/repo", undefined, undefined]);
  assert.equal(d.log.at(-1).result.cause, undefined);
});

test("pre-review L2: every call writes at most one phase row", async () => {
  const d = fake({ provisionOnce: async () => ({ error: "provider_error" }) });
  for (let i = 0; i < 6; i++) {
    const before = d.log.length;
    await probeStep(d);
    assert.ok(d.log.length - before <= 1);
  }
});

test("pre-review L3: a changed fingerprint mid-cycle purges and fails with fingerprint-changed", async () => {
  const d = fake();
  await probeStep(d); await probeStep(d); // start, run1 done
  d.fingerprint = "fp-2";
  const r = await probeStep(d);
  assert.deepEqual([r.phase, r.code], ["purge", "in_progress"]);
  const end = await probeStep(d);
  assert.deepEqual([end.exit, end.code], [1, "fingerprint-changed"]);
  assert.equal(d.calls.purge, 1);
});

// A fake Prisma client: `$transaction(fn)` runs fn on the same object (the bound is passed and checked).
function fakeDb(seed = {}) {
  const db = {
    projects: [...(seed.projects ?? [])], audits: [...(seed.audits ?? [])], bounds: [],
    async $transaction(fn, o) { db.bounds.push(o); return fn(db); },
    project: {
      findUnique: async ({ where }) => db.projects.find((p) => p.slug === where.slug) ?? null,
      create: async ({ data }) => { const p = { id: `id-${db.projects.length + 1}`, stage: "intake", ...data }; db.projects.push(p); return { id: p.id, slug: p.slug, name: p.name }; },
      updateMany: async ({ where, data }) => { const ps = db.projects.filter((p) => p.id === where.id && (where.pausedAt !== null || !p.pausedAt)); ps.forEach((p) => Object.assign(p, data)); return { count: ps.length }; },
    },
    auditEvent: {
      findFirst: async ({ where }) => db.audits.filter((a) => a.projectId === where.projectId && a.action === where.action).at(-1) ?? null,
      create: async ({ data }) => { db.audits.push({ id: `a-${db.audits.length + 1}`, ...data }); return {}; },
    },
  };
  return db;
}
const NOW = new Date("2026-11-16T00:00:00Z");

test("pre-review M3: ensureProbeProject creates a paused, least-cap probe row with its started row; re-pauses its own row", async () => {
  const db = fakeDb();
  const p = await ensureProbeProject(db, NOW, 5000);
  const row = db.projects[0];
  assert.deepEqual([row.slug, row.capUsd, row.pausedAt, row.stage], [PROBE_SLUG, "0.000001", NOW, "intake"]);
  assert.equal(db.audits.filter((a) => a.action === "provision.probe_started" && a.projectId === p.id).length, 1);
  row.pausedAt = null;
  const again = await ensureProbeProject(db, NOW, 5000);
  assert.equal(again.id, p.id);
  assert.equal(row.pausedAt, NOW, "an unpaused probe row is paused again, so the sweep never lists it");
  assert.equal(db.projects.length, 1);
  assert.ok(db.bounds.every((b) => b.timeout === 5000 && b.maxWait === 5000), "every call is bounded");
});

test("pre-review M2: a real project holding the probe's slug is refused and left unchanged", async () => {
  const real = { id: "real-1", slug: PROBE_SLUG, name: "Someone's app", pausedAt: null };
  const db = fakeDb({ projects: [real] });
  await assert.rejects(ensureProbeProject(db, NOW, 5000), /probe-slug-taken/);
  assert.equal(real.pausedAt, null);
  assert.equal(db.audits.length, 0);
});

test("pre-review M3: PrismaProbeLog round-trips, returns null with no rows, and refuses an unreadable newest row", async () => {
  const db = fakeDb();
  const log = new PrismaProbeLog(db, "id-1", 5000);
  assert.equal(await log.last(), null);
  const r = { cycle: 1, phase: "run1", at: NOW.toISOString(), fingerprint: "fp" };
  await log.record(r);
  assert.equal(db.audits[0].action, "provision.probe_phase");
  assert.equal(db.audits[0].projectId, "id-1");
  assert.deepEqual(await log.last(), r);
  db.audits.push({ projectId: "id-1", action: "provision.probe_phase", details: { cycle: "x" } });
  await assert.rejects(log.last(), /probe-phase-unreadable/);
});

// DEVOS-21 diagnostics, part 4: a final stop names the step, the stage and the cause's fixed code, through the
// real @devos/provision runner (so a reworded runner message fails here instead of silently losing the stage).
test("part 4: a final run stop names step, stage and cause through the real runner; never a message", async () => {
  const { runStep, MemoryStore, allowAll, ProviderError, StepError } = await import("@devos/provision");
  const pv = (run) => ({ ready: async () => null, run });
  const spec = (over) => ({ key: "github/repo", provider: "github", kind: "repo", name: "devos-probe-m24", action: "provision.github.repo",
    lookup: async () => null, create: async () => { throw new Error("unset"); }, ...over });
  const through = (over) => probeProvisionOnce(pv(() => runStep(P.id, spec(over), { store: new MemoryStore(), authorize: allowAll })), P);
  const secret = "token=ghp_secret body: Bad credentials";
  // A create refused with 403: final, names the call.
  assert.deepEqual(await through({ create: async () => { throw new ProviderError("github", "http", `github POST /user/repos returned 403 ${secret}`, 403); } }),
    { error: "provider_error:github/repo:create:http-403" });
  // 422 with nothing found under our name: rejected.
  assert.deepEqual(await through({ create: async () => { throw new ProviderError("github", "http", secret, 422); } }),
    { error: "provider_error:github/repo:rejected:http-422" });
  // A lookup that fails for good (a 404 is not transient), and an unreadable answer.
  assert.deepEqual(await through({ lookup: async () => { throw new ProviderError("github", "http", secret, 404); } }),
    { error: "provider_error:github/repo:lookup:http-404" });
  assert.deepEqual(await through({ key: "coolify/application/production", provider: "coolify", kind: "application",
    lookup: async () => { throw new ProviderError("coolify", "bad-response", secret, 200); } }),
    { error: "provider_error:coolify/application/production:lookup:bad-response-200" });
  // A missing token (no status), a hook refusal with its own fixed code, a plain error: the code alone.
  assert.deepEqual(await through({ create: async () => { throw new ProviderError("github", "no-token", secret); } }),
    { error: "provider_error:github/repo:create:no-token" });
  assert.deepEqual(await through({ create: async () => { throw Object.assign(new Error(secret), { code: "compose_unsafe" }); } }),
    { error: "provider_error:github/repo:create:compose_unsafe" });
  assert.deepEqual(await through({ create: async () => { throw new Error(secret); } }), { error: "provider_error:github/repo:create" });
  // A created resource without our marker.
  assert.deepEqual(await through({ create: async () => ({ externalId: "1", name: "x", owned: false }) }), { error: "provider_error:github/repo:marker" });
  // A transient failure stays in progress (the next tick runs again).
  assert.equal(await through({ lookup: async () => { throw new ProviderError("github", "http", secret, 502); } }), "in_progress");
  // A step's own typed stop keeps its code and step; no stage or cause is invented.
  assert.deepEqual(await probeProvisionOnce(pv(async () => { throw new StepError("coolify/environment/production", "port_range_exhausted", false, true, "no free port"); }), P),
    { error: "port_range_exhausted:coolify/environment/production" });
  // Odd step keys and cause codes are left out, never printed.
  assert.deepEqual(await probeProvisionOnce(pv(async () => { throw new StepError("vault/app_secret/production/DATABASE_URL", "provider_error", false, true, "create failed for vault x", new Error("x")); }), P),
    { error: "provider_error" });
  assert.deepEqual(await probeProvisionOnce(pv(async () => { throw new StepError("github/repo", "provider_error", false, true, "create failed for github repo", { code: "Bad Code!" }); }), P),
    { error: "provider_error:github/repo:create" });
  assert.deepEqual(await probeProvisionOnce(pv(async () => { throw new StepError("github/repo", "provider_error", false, true, "create failed for github repo", new ProviderError("github", "http", "x", 1000)); }), P),
    { error: "provider_error:github/repo:create:http" });
});

test("part 4: the run failure detail reaches the done record and survives the CLI filter", async () => {
  const { safeDetail } = await import("../dist/provision-probe-cli.js");
  const d = fake({ provisionOnce: async () => ({ error: "provider_error:coolify/application/production:rejected:bad-response-200" }) });
  const end = (await runToEnd(d)).at(-1);
  assert.deepEqual([end.exit, end.code, end.detail], [1, "run1-failed", "provider_error:coolify/application/production:rejected:bad-response-200"]);
  assert.equal(safeDetail(end.detail), end.detail);
});
