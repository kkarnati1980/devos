// DEVOS-234 (M2.4-d3c-2a, docs/modules/M2.4.md "M2.4-d3c-2 decisions"): the probe's purge through M2.5 under a KK grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grantProblem } from "@devos/policy";
import { teardownWiring, purgeStop, forbiddenTail, probePurge, findProbeGrant, grantAuthorizer, probeCycleStart, probeStage, probeGrantOutlasts, teardownResource, PROBE_GRANT_ACTIONS, PROBE_PURGE_RETRY_USES } from "../dist/provision-probe-purge.js";
import * as realProvision from "@devos/provision";
import * as realTeardown from "@devos/teardown";
import { probeStep } from "../dist/provision-probe.js";

const PID = "11111111-1111-4111-8111-111111111111";
const terr = (code, retryable = false, resource) => Object.assign(new Error(`teardown ${code} with a provider body`), { name: "TeardownError", code, retryable, resource });

function fakeModules() {
  const calls = [];
  const ops = (provider, kind) => (client, id) => { calls.push([`${provider}/${kind}`, client, id]); return { provider, kind }; };
  const pm = {
    pinnedGitHub: async (gh) => ({ pinned: gh }),
    pinnedCoolify: async (cf) => ({ pinned: cf }),
    githubRepoOps: ops("github", "repo"),
    githubDeployKeyOps: ops("github", "deploy_key"),
    coolifyProjectOps: ops("coolify", "project"),
    coolifyEnvironmentOps: ops("coolify", "environment"),
    coolifyApplicationOps: ops("coolify", "application"),
    coolifyPrivateKeyOps: ops("coolify", "private_key"),
    coolifyPortOps: () => ({ provider: "coolify", kind: "port" }),
    backupScheduleOps: () => ({ provider: "backup_schedule", kind: "nightly" }),
    githubScanner: (gh) => { calls.push(["scan:github", gh]); return { name: "github" }; },
    coolifyScanner: (cf) => { calls.push(["scan:coolify", cf]); return { name: "coolify" }; },
    githubTokenScopeCheck: (gh, o) => { calls.push(["check:github", gh, o]); return async () => {}; },
    coolifyTokenScopeCheck: (cf, recorded) => { calls.push(["check:coolify", cf, recorded]); return async () => {}; },
  };
  const tm = {
    inventoryScanner: () => ({ name: "inventory" }),
    vaultScanner: (_db, ms) => { calls.push(["scan:vault", ms]); return { name: "vault" }; },
  };
  return { pm, tm, calls };
}

test("d3c-2a decision 2: the wiring covers every recorded kind, the required scanners and both preflights, on pinned clients", async () => {
  const { pm, tm, calls } = fakeModules();
  const store = { activeResources: async () => [{ provider: "coolify", kind: "project" }] };
  const w = await teardownWiring(pm, tm, { gh: "GH", cf: "CF", store, db: {}, projectId: PID, owner: "kkarnati1980", timeoutMs: 1234 });
  assert.deepEqual(w.ops.map((o) => `${o.provider}/${o.kind}`).sort(), [
    "backup_schedule/nightly", "coolify/application", "coolify/environment", "coolify/port", "coolify/private_key", "coolify/project", "github/deploy_key", "github/repo",
  ]);
  assert.deepEqual(w.scanners.map((s) => s.name), ["inventory", "vault", "github", "coolify", "backup_schedule"]);
  assert.equal(w.preflight.length, 2);
  // DEVOS-235 decision 4: every provider op, scanner and check gets the one pinned client of its provider.
  for (const c of calls) {
    if (c[0].startsWith("github") || c[0].endsWith(":github")) assert.deepEqual(c[1], { pinned: "GH" }, c[0]);
    if (c[0].startsWith("coolify") || c[0].endsWith(":coolify")) assert.deepEqual(c[1], { pinned: "CF" }, c[0]);
    if (c[0].includes("/")) assert.equal(c[2], PID, c[0]);
  }
  assert.deepEqual(calls.find((c) => c[0] === "check:github")[2], { owner: "kkarnati1980" });
  assert.deepEqual(await calls.find((c) => c[0] === "check:coolify")[2](), [{ provider: "coolify", kind: "project" }], "the Coolify check reads the live inventory");
  assert.deepEqual(calls.find((c) => c[0] === "scan:vault"), ["scan:vault", 1234], "the vault scan is bounded");
});

test("d3c-2a decision 1: teardown stops map to fixed probe codes; retryable is in progress; other throws are rethrown", () => {
  assert.equal(purgeStop(terr("delete_unconfirmed", true)), "in_progress");
  assert.equal(purgeStop(terr("provider_error", true)), "in_progress");
  assert.deepEqual(purgeStop(terr("provider_forbidden")), { error: "purge-permission:preflight" }, "DEVOS-21: no resource means the preflight refused");
  assert.deepEqual(purgeStop(terr("provider_forbidden", false, { provider: "github", kind: "repo", externalId: "1", name: "kk/secret-name" })), { error: "purge-permission:github/repo" }, "DEVOS-21: the refusing provider and kind are named, never the name");
  assert.deepEqual(purgeStop(terr("provider_forbidden", false, { provider: "coolify", kind: "Bad Kind!" })), { error: "purge-permission:resource" }, "an odd kind is never printed, and it is not read as the preflight");
  assert.deepEqual(purgeStop(terr("approval_required")), { error: "purge-permission:approval_required" });
  assert.deepEqual(purgeStop(terr("policy_denied")), { error: "purge-permission:policy_denied" });
  assert.deepEqual(purgeStop(terr("ownership_mismatch", false, { provider: "github", kind: "repo", externalId: "1", name: "kk/secret-name" })), { error: "purge-ownership:github/repo" });
  assert.deepEqual(purgeStop(terr("unsupported_resource", false, { provider: "coolify", kind: "volume" })), { error: "purge-incomplete:unsupported_resource:coolify/volume" });
  assert.deepEqual(purgeStop(terr("scan_incomplete")), { error: "purge-incomplete:scan_incomplete" });
  assert.deepEqual(purgeStop(terr("ownership_mismatch", false, { provider: "github", kind: "Bad Kind!" })), { error: "purge-ownership" }, "an odd kind is never printed");
  const other = new Error("ECONNRESET at https://user:pw@example");
  assert.throws(() => purgeStop(other), (e) => e === other);
});

test("DEVOS-21 part 9: a final provider_error names the kind, the teardown stage and the cause, never the resource", () => {
  const pe = (message, resource = { provider: "coolify", kind: "application", externalId: "u1", name: "kk-secret-name" }) =>
    Object.assign(new Error(message), { name: "TeardownError", code: "provider_error", retryable: false, resource });
  const d = "coolify application kk-secret-name (u1)";
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: coolify DELETE /api/v1/applications/u1 returned 422`)), { error: "purge-provider-error:coolify/application:delete:http-422" });
  assert.deepEqual(purgeStop(pe(`lookup of ${d} failed: coolify token is not available from the vault`)), { error: "purge-provider-error:coolify/application:lookup:no-token" });
  assert.deepEqual(purgeStop(pe(`archive of ${d} failed: coolify-uuid-invalid`)), { error: "purge-provider-error:coolify/application:archive:coolify-uuid-invalid" });
  assert.deepEqual(purgeStop(pe(`restore of ${d} failed: unexpected error`)), { error: "purge-provider-error:coolify/application:restore:unexpected" });
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: some provider text with ghp_secret`)), { error: "purge-provider-error:coolify/application:delete:provider" }, "other text is never echoed");
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: ghp-abcdefghijklmnopqrstuvwxyz0123456789-x`)), { error: "purge-provider-error:coolify/application:delete:provider" }, "a long dash token is not a reason code");
  assert.deepEqual(purgeStop(pe(`something else failed: x returned 500`)), { error: "purge-provider-error:coolify/application" }, "an unknown message form names only the kind");
  assert.deepEqual(purgeStop(pe(`delete of ${d} was interrupted`)), { error: "purge-provider-error:coolify/application" }, "Codex PR233-r1: a stage prefix without the separator is an unknown form");
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: x returned 500`, { provider: "coolify", kind: "Bad Kind!" })), { error: "purge-provider-error" }, "an odd kind prints nothing more");
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: x returned 500`, null)), { error: "purge-provider-error" });
  assert.deepEqual(purgeStop(pe(`delete of ${d} failed: some-id-like-slug`)), { error: "purge-provider-error:coolify/application:delete:provider" }, "pre-review 1: only an -invalid reason code is echoed");
  assert.deepEqual(purgeStop(pe(`lookup of ${d} failed: coolify GET /api/v1/applications/u1 returned invalid JSON`)), { error: "purge-provider-error:coolify/application:lookup:provider" }, "a bad response reads provider");
  const long = "a".repeat(40);
  assert.deepEqual(purgeStop(pe(`delete of x failed: ${long.slice(0, 32)}-invalid`, { provider: long, kind: long })), { error: `purge-provider-error:${long}/${long}` }, "a detail over 120 characters drops its tail");
});

function purgeDeps(over = {}) {
  const calls = [];
  const d = {
    calls,
    teardown: {
      archiveProject: async (id, o) => { calls.push(["archive", id, Object.keys(o).sort()]); },
      purgeProject: async (id, o) => { calls.push(["purge", id, Object.keys(o).sort()]); return { purged: true, report: { hits: [], errors: [] } }; },
    },
    stage: async () => "live",
    wiring: async () => ({ ops: [{ provider: "github", kind: "repo" }], scanners: [{ name: "inventory" }], preflight: [async () => {}] }),
    store: {},
    authorize: async () => "allow",
    ...over,
  };
  return d;
}

test("d3c-2a decision 1: Archive then Purge; an archived row skips Archive; a purged row is done without a call", async () => {
  const d = purgeDeps();
  assert.equal(await probePurge(PID, d), "done");
  assert.deepEqual(d.calls, [
    ["archive", PID, ["authorize", "ops", "store"]],
    ["purge", PID, ["authorize", "ops", "preflight", "scanners", "store"]],
  ]);
  const a = purgeDeps({ stage: async () => "archived" });
  assert.equal(await probePurge(PID, a), "done");
  assert.deepEqual(a.calls.map((c) => c[0]), ["purge"]);
  const p = purgeDeps({ stage: async () => "purged", wiring: async () => { throw new Error("must not build"); } });
  assert.equal(await probePurge(PID, p), "done");
  assert.deepEqual(p.calls, []);
});

test("DEVOS-254 pre-review r2 3: a not_archived stop on a row another purge finished is done; otherwise it keeps its code", async () => {
  let stage = "archived";
  const won = purgeDeps({ stage: async () => stage, teardown: { archiveProject: async () => {}, purgeProject: async () => { stage = "purged"; throw terr("not_archived"); } } });
  assert.equal(await probePurge(PID, won), "done");
  const lost = purgeDeps({ stage: async () => "archived", teardown: { archiveProject: async () => {}, purgeProject: async () => { throw terr("not_archived"); } } });
  assert.deepEqual(await probePurge(PID, lost), { error: "purge-not-archived" });
});

test("d3c-2a decision 1: a leftover or scan error is purge-incomplete; a teardown stop keeps its code", async () => {
  const hit = purgeDeps({ teardown: { archiveProject: async () => {}, purgeProject: async () => ({ purged: false, report: { hits: [{ provider: "github", kind: "inventory:repo", name: "kk/x" }], errors: [] } }) } });
  assert.deepEqual(await probePurge(PID, hit), { error: "purge-incomplete:leftover:github/repo" });
  const err = purgeDeps({ teardown: { archiveProject: async () => {}, purgeProject: async () => ({ purged: false, report: { hits: [], errors: ["github: 502"] } }) } });
  assert.deepEqual(await probePurge(PID, err), { error: "purge-incomplete:scan-error" });
  const forb = purgeDeps({ teardown: { archiveProject: async () => { throw terr("provider_forbidden", false, { provider: "github", kind: "repo" }); }, purgeProject: async () => assert.fail("no purge after a failed archive") } });
  assert.deepEqual(await probePurge(PID, forb), { error: "purge-permission:github/repo" });
  const retry = purgeDeps({ teardown: { archiveProject: async () => {}, purgeProject: async () => { throw terr("delete_unconfirmed", true); } } });
  assert.equal(await probePurge(PID, retry), "in_progress");
});

function grantDb(rows) {
  const seen = [];
  const db = {
    approvalGrant: { findMany: async (q) => { seen.push(q); return rows; } },
  };
  db.$transaction = async (fn, o) => { seen.push(o); return fn(db); };
  return { db, seen };
}
const NOW = new Date("2026-11-16T08:00:00Z");
const grant = (over = {}) => ({ id: "g-1", approvalId: null, scopeAction: "teardown.*", scopeResource: null, projectId: PID, sha: null, issuedBy: "kk:kishore", issuedAt: NOW, expiresAt: new Date("2027-01-01T00:00:00Z"), maxUses: 30, uses: 0, revokedAt: null, ...over });

test("d3c-2a decision 3: a KK grant for teardown.* on the probe project is found read-only; anything narrower is not", async () => {
  const { db, seen } = grantDb([grant()]);
  assert.equal(await findProbeGrant(db, PID, NOW, 1234, grantProblem), "g-1");
  assert.deepEqual(seen[0], { timeout: 1234, maxWait: 1234 }, "one bounded read");
  // Codex PR239-r5: a grant issued for a purge card is the sweep's and is never selected.
  assert.deepEqual(seen[1].where, { projectId: PID, revokedAt: null, expiresAt: { gt: NOW },
    OR: [{ approvalId: null }, { approval: { is: { action: { not: "teardown.purge" } } } }] });
  assert.deepEqual([...PROBE_GRANT_ACTIONS], ["teardown.archive", "teardown.purge"]);
  for (const [why, g] of [
    ["purge only", grant({ scopeAction: "teardown.purge" })],
    ["not KK", grant({ issuedBy: "agent:runner" })],
    ["one use left", grant({ uses: 29 })],
    ["expired", grant({ expiresAt: new Date("2026-11-01T00:00:00Z") })],
    ["another project", grant({ projectId: "22222222-2222-4222-8222-222222222222" })],
    ["pinned to another resource", grant({ scopeResource: "other" })],
    ["pinned to the bare id (teardown asks about project:<id>)", grant({ scopeResource: PID })],
  ]) {
    assert.equal(await findProbeGrant(grantDb([g]).db, PID, NOW, 1234, grantProblem), null, why);
  }
  assert.equal(await findProbeGrant(grantDb([grant({ id: "bad", uses: 30 }), grant({ id: "good" })]).db, PID, NOW, 1234, grantProblem), "good", "the next usable grant");
  // Pre-review 2: a grant pinned to the resource teardown authorizes is accepted.
  assert.equal(teardownResource(PID), `project:${PID}`);
  assert.equal(await findProbeGrant(grantDb([grant({ scopeResource: `project:${PID}` })]).db, PID, NOW, 1234, grantProblem), "g-1");
  // Pre-review 4: an archived row needs only the purge's use.
  assert.equal(await findProbeGrant(grantDb([grant({ uses: 29 })]).db, PID, NOW, 1234, grantProblem, ["teardown.purge"]), "g-1");
  assert.equal(await findProbeGrant(grantDb([grant({ scopeAction: "teardown.purge" })]).db, PID, NOW, 1234, grantProblem, ["teardown.purge"]), "g-1");
});

test("Codex PR239-r7/r8: probeGrantOutlasts asks for the grant at the later time, with every use the cycle may still spend", async () => {
  const LATER = new Date("2026-12-05T08:00:00Z");
  const withStage = (stage, rows) => {
    const g = grantDb(rows);
    g.db.project = { findUnique: async (q) => { g.seen.push(q); return { stage } } };
    return g;
  };
  // Valid now, but expired by the later time: not enough.
  assert.equal(await probeGrantOutlasts(withStage("live", [grant({ expiresAt: new Date("2026-12-01T00:00:00Z") })]).db, PID, LATER, 1234, grantProblem), false);
  const { db, seen } = withStage("live", [grant()]);
  assert.equal(await probeGrantOutlasts(db, PID, LATER, 1234, grantProblem), true);
  assert.deepEqual(seen.find((q) => q && q.where && q.where.expiresAt).where.expiresAt, { gt: LATER }, "the read asks about the later time");
  assert.ok(seen.filter((q) => q && "timeout" in q).every((o) => o.timeout === 1234 && o.maxWait === 1234), "bounded reads");
  // Codex PR239-r8: a fallback purge after a Restore needs an Archive and a purge again; r9: plus the retry uses. Not
  // archived yet: the card's Archive, those two and the retries (6 of 30); archived: those two and the retries (5).
  assert.equal(PROBE_PURGE_RETRY_USES, 3);
  assert.equal(await probeGrantOutlasts(withStage("live", [grant({ uses: 24 })]).db, PID, LATER, 1234, grantProblem), true);
  assert.equal(await probeGrantOutlasts(withStage("live", [grant({ uses: 25 })]).db, PID, LATER, 1234, grantProblem), false);
  assert.equal(await probeGrantOutlasts(withStage("archived", [grant({ uses: 25 })]).db, PID, LATER, 1234, grantProblem), true);
  assert.equal(await probeGrantOutlasts(withStage("archived", [grant({ uses: 26 })]).db, PID, LATER, 1234, grantProblem), false);
  // Both actions must be in scope even once archived (the Restore fallback archives again).
  assert.equal(await probeGrantOutlasts(withStage("archived", [grant({ scopeAction: "teardown.purge" })]).db, PID, LATER, 1234, grantProblem), false);
});

test("d3c-2a decision 3: the authorizer presents the grant to the M1.7 engine as the system provisioner", async () => {
  const seen = [];
  const policy = { decide: async (r) => { seen.push(r); return { enforcedOutcome: seen.length === 1 ? "allow" : seen.length === 2 ? "require_approval" : "deny" }; } };
  const a = grantAuthorizer(policy, PID, "g-1");
  assert.equal(await a("teardown.purge", PID), "allow");
  assert.equal(await a("teardown.purge", PID), "require_approval");
  assert.equal(await a("teardown.purge", PID), "deny");
  assert.deepEqual(seen[0], { identity: { id: "system:provisioner", type: "system" }, action: { type: "teardown.purge", resource: PID, projectId: PID }, approvalGrantId: "g-1" });
});

function projectDb(stage, activeRows = 0) {
  const writes = [];
  const db = {
    writes,
    resource: { count: async (q) => { writes.push(["count", q.where]); return activeRows; } },
    project: {
      findUnique: async () => (stage === null ? null : { stage }),
      updateMany: async (q) => { writes.push(["update", q]); return { count: 1 }; },
    },
    auditEvent: { create: async (q) => { writes.push(["audit", q.data.action, q.data.projectId]); } },
  };
  db.$transaction = async (fn, o) => { writes.push(["tx", o]); return fn(db); };
  return db;
}

test("d3c-2a decisions 4 and 5: no grant blocks the cycle; purged resets only the probe row; archived starts with the purge", async () => {
  const none = projectDb("live");
  assert.deepEqual(await probeCycleStart(none, PID, 1234, async () => false), { blocked: "probe-purge-not-approved" });
  assert.deepEqual(none.writes, [], "nothing read or written without a grant");
  const live = projectDb("live");
  assert.equal(await probeCycleStart(live, PID, 1234, async () => true), "ready");
  assert.deepEqual(live.writes, [["tx", { timeout: 1234, maxWait: 1234 }], ["count", { projectId: PID, status: "active" }]]);
  // Pre-review 5: rows left behind by a cycle whose archive was refused are purged first.
  assert.equal(await probeCycleStart(projectDb("live", 3), PID, 1234, async () => true), "purge-pending");
  const purged = projectDb("purged");
  assert.equal(await probeCycleStart(purged, PID, 1234, async () => true), "ready");
  assert.deepEqual(purged.writes.slice(1), [
    ["update", { where: { id: PID, stage: "purged" }, data: { stage: "intake", archivedAt: null, purgeAfter: null } }],
    ["audit", "provision.probe_reset", PID],
  ]);
  assert.equal(await probeCycleStart(projectDb("archived"), PID, 1234, async () => true), "purge-pending");
  await assert.rejects(probeCycleStart(projectDb(null), PID, 1234, async () => true), /probe-project-missing/);
  assert.equal(await probeStage(projectDb("archived"), PID, 1234), "archived");
});

function stepDeps(over = {}) {
  const log = [];
  const d = {
    log,
    fingerprint: "fp",
    now: () => new Date("2026-11-16T00:00:00Z"),
    offReason: async () => null,
    last: async () => log.at(-1) ?? null,
    record: async (r) => { log.push(structuredClone(r)); },
    provisionOnce: async () => "done",
    inventory: async () => [{ key: "github_repo", provider: "github", externalId: "1", name: "x" }],
    liveAsserts: async () => [],
    purge: async () => "done",
    ...over,
  };
  return d;
}

test("d3c-2a decision 4: a blocked cycle start is skipped and records nothing", async () => {
  const d = stepDeps({ cycleStart: async () => ({ blocked: "probe-purge-not-approved" }), provisionOnce: async () => assert.fail("no run") });
  const t = await probeStep(d);
  assert.deepEqual([t.exit, t.code, t.detail], [3, "skipped", "probe-purge-not-approved"]);
  assert.equal(d.log.length, 0);
});

test("d3c-2a decision 4: a cycle that starts with a pending purge purges first and never reports a pass", async () => {
  let purges = 0;
  const d = stepDeps({ cycleStart: async () => "purge-pending", provisionOnce: async () => assert.fail("no run"), purge: async () => { purges++; return "done"; } });
  const a = await probeStep(d);
  assert.deepEqual([a.exit, a.phase, a.code], [3, "purge", "in_progress"]);
  const b = await probeStep(d);
  assert.deepEqual([b.exit, b.phase, b.code], [1, "done", "previous-purge-pending"]);
  assert.equal(purges, 1);
});

test("d3c-2a pre-review 1: the real teardown accepts the wiring built from the real provision ops and reaches purged", async () => {
  // Real @devos/provision op factories (so the provider set is the real one) and the real purgeProject's
  // scanner rule. Only the network pieces are stubbed: pinned clients, the two provider scans and the preflights.
  const pm = {
    ...realProvision,
    pinnedGitHub: async () => ({}),
    pinnedCoolify: async () => ({}),
    githubScanner: () => ({ name: "github", scan: async () => [] }),
    coolifyScanner: () => ({ name: "coolify", scan: async () => [] }),
  };
  const store = new realTeardown.MemoryTeardownStore();
  store.addProject({ id: PID, slug: "devos-probe-m24", stage: "archived" });
  // A backup schedule row: its ops never call a provider, so the whole purge runs offline.
  await store.recordResource(PID, { provider: "backup_schedule", kind: "nightly", externalId: `${PID}/live`, name: "devos-probe-m24/live" });
  const db = { vaultSecret: { findMany: async () => [] } };
  const w = await teardownWiring(pm, realTeardown, { gh: {}, cf: {}, store, db, projectId: PID, owner: "kkarnati1980", timeoutMs: 1000 });
  const needed = new Set(w.ops.map((o) => o.provider));
  for (const p of needed) assert.ok(w.scanners.some((x) => x.name === p), `a scanner for ${p}`);
  const out = await probePurge(PID, {
    teardown: realTeardown,
    store,
    authorize: async () => "allow",
    stage: async () => "archived",
    wiring: async () => ({ ...w, preflight: [] }),
  });
  assert.equal(out, "done");
});

// DEVOS-21 part 2: the real purge preflight (the real @devos/provision checks inside the real purgeProject) maps to a
// fixed code that names the refusing token and the reason; no message text, count or status is ever printed.
test("DEVOS-21 part 2: a refused purge preflight names the token and the reason, as a fixed code", async () => {
  const store = {
    withProjectLock: async (_id, fn) => fn(), assertLockHeld: async () => {}, project: async () => ({ id: PID, stage: "archived" }),
    activeResources: async () => [], resetSteps: async () => {}, saveScan: async () => {}, deleteProjectSecrets: async () => 0, markPurged: async () => {},
  };
  const http = (routes) => ({ get: async (path) => routes(path) });
  const gh = (routes) => ({ http: { pinned: async () => http(routes) } });
  const cf = (routes) => ({ http: http(routes) });
  // DEVOS-252 (Codex PR223-r18/r36): listed entries are identifiable repos of the owner that say whether they
  // are private, so the count case reaches the count rule (a fixture correction: `{}` entries are now unreadable).
  const user = (body) => (p) => (p === "/user" ? { status: 200, body } : { status: 200, body: [{ id: 1, name: "a", private: false, owner: { login: "kk" } }, { id: 2, name: "b", private: true, owner: { login: "kk" } }] });
  const coolRow = [{ provider: "coolify", kind: "project", externalId: "abc-123" }];
  const cases = [
    [realProvision.githubTokenScopeCheck(gh(() => ({ status: 200, body: { login: "kk" } })), { owner: "kk" }), "github-counts"],
    [realProvision.githubTokenScopeCheck(gh(user({ login: "someone-else", public_repos: 1, owned_private_repos: 1 })), { owner: "kk" }), "github-owner"],
    [realProvision.githubTokenScopeCheck(gh((p) => (p === "/user" ? { status: 200, body: { login: "kk", public_repos: 1, owned_private_repos: 1 } } : { status: 200, body: {} })), { owner: "kk" }), "github-list"],
    [realProvision.githubTokenScopeCheck(gh(user({ login: "kk", public_repos: 1, owned_private_repos: 6 })), { owner: "kk" }), "github-repos"],
    // Codex PR223-r36: the total is met, but public entries stand in for a private repository the token does not see.
    [realProvision.githubTokenScopeCheck(gh(user({ login: "kk", public_repos: 0, owned_private_repos: 2 })), { owner: "kk" }), "github-repos"],
    // DEVOS-21 part 3: a classic token (scopes header) without `repo` and without the private count.
    [realProvision.githubTokenScopeCheck(gh((p) => (p === "/user" ? { status: 200, body: { login: "kk", public_repos: 1 }, headers: new Headers({ "x-oauth-scopes": "delete_repo" }) } : { status: 200, body: [{}] })), { owner: "kk" }), "github-scopes"],
    [realProvision.githubTokenScopeCheck(gh((p) => (p === "/user" ? { status: 200, body: { login: "kk", public_repos: 1 } } : { status: 200, body: [{}] })), { owner: "kk" }), "github-counts"],
    [realProvision.coolifyTokenScopeCheck(cf(() => ({ status: 200 })), async () => [{ ...coolRow[0], externalId: "not a uuid!" }]), "coolify-id"],
    [realProvision.coolifyTokenScopeCheck(cf(() => ({ status: 404, body: {} })), async () => coolRow), "coolify-team"],
    [realProvision.coolifyTokenScopeCheck(cf(() => ({ status: 200, body: { uuid: "other" } })), async () => coolRow), "coolify-answer"],
  ];
  for (const [check, code] of cases) {
    let err;
    try {
      await realTeardown.purgeProject(PID, { store, authorize: async () => "allow", ops: [], scanners: [{ name: "inventory" }, { name: "vault" }], preflight: [check] });
    } catch (e) { err = e; }
    assert.equal(err?.name, "TeardownError", code);
    assert.deepEqual(purgeStop(err), { error: `purge-permission:preflight:${code}` }, code);
  }
  // Pre-review 1/2: what the real transport throws (a non-transient ProviderError) for a missing, expired or narrowed
  // token names the token too; the path, status text and any other detail are never printed.
  const { ProviderError } = realProvision;
  assert.equal(typeof ProviderError, "function");
  const thrown = (provider, status) => async () => { throw new ProviderError(provider, "http", `${provider} GET /user/repos returned ${status}`, status); };
  const noToken = (provider) => async () => { throw new ProviderError(provider, "no-token", `${provider} token is not available from the vault`); };
  const transport = [
    [realProvision.githubTokenScopeCheck({ http: { pinned: async () => ({ get: thrown("github", 401) }) } }, { owner: "kk" }), "github-http-401"],
    [realProvision.githubTokenScopeCheck({ http: { pinned: async () => ({ get: thrown("github", 403) }) } }, { owner: "kk" }), "github-http-403"],
    [realProvision.coolifyTokenScopeCheck({ http: { get: thrown("coolify", 401) } }, async () => coolRow), "coolify-http-401"],
    [realProvision.coolifyTokenScopeCheck({ http: { get: thrown("coolify", 422) } }, async () => coolRow), "coolify-http-422"],
    [realProvision.coolifyTokenScopeCheck({ http: { get: thrown("coolify", 409) } }, async () => coolRow), "coolify"],
    [realProvision.githubTokenScopeCheck({ http: { pinned: async () => ({ get: noToken("github") }) } }, { owner: "kk" }), "github-no-token"],
    [realProvision.coolifyTokenScopeCheck({ http: { get: noToken("coolify") } }, async () => coolRow), "coolify-no-token"],
  ];
  for (const [check, code] of transport) {
    let err;
    try {
      await realTeardown.purgeProject(PID, { store, authorize: async () => "allow", ops: [], scanners: [{ name: "inventory" }, { name: "vault" }], preflight: [check] });
    } catch (e) { err = e; }
    assert.equal(err?.name, "TeardownError", code);
    assert.equal(err.retryable, false, code);
    assert.deepEqual(purgeStop(err), { error: `purge-permission:preflight:${code}` }, code);
  }
  // A preflight message from neither check keeps the plain code; an unknown reason keeps only the token's name.
  const msg = (m) => Object.assign(terr("provider_forbidden"), { message: m });
  assert.deepEqual(purgeStop(msg("purge preflight: something else: 7 of 9")), { error: "purge-permission:preflight" });
  assert.deepEqual(purgeStop(msg("purge preflight: github-token-scope: a new reason 3 of 4")), { error: "purge-permission:preflight:github" });
  assert.deepEqual(purgeStop(msg("purge preflight: coolify-token-scope: a new reason")), { error: "purge-permission:preflight:coolify" });
  assert.deepEqual(purgeStop(msg("xx purge preflight: github-token-scope: belongs to another account than the repository owner")), { error: "purge-permission:preflight" }, "anchored: only teardown's own wrap counts");
});

// Codex PR222-r2 (supersedes the r1 fix): readToken reports an absent token, a failed vault read and a vault timeout
// all as `no-token`, so a throw while the wiring pins its clients must stay retryable (rethrown → in progress), never
// a terminal credential code. An absent token is already named before the cycle by offReasonFor (provisioner.ready()).
test("DEVOS-21 part 2 (PR222-r2): a throw while the purge wiring pins its clients stays in progress", async () => {
  const { ProviderError } = realProvision;
  const missing = (provider) => ({ http: { pinned: async () => { throw new ProviderError(provider, "no-token", `${provider} token is not available from the vault`); } } });
  const okClient = { http: { pinned: async () => ({ get: async () => ({ status: 200, body: {} }) }) } };
  const store = { activeResources: async () => [] };
  for (const [gh, cf] of [[missing("github"), okClient], [okClient, missing("coolify")]]) {
    let ran = 0;
    await assert.rejects(probePurge(PID, {
      teardown: { ...realTeardown, archiveProject: async () => { ran++; }, purgeProject: async () => { ran++; } },
      stage: async () => "archived",
      wiring: () => teardownWiring(realProvision, realTeardown, { gh, cf, store, db: {}, projectId: PID, owner: "kk", timeoutMs: 1000 }),
      store, authorize: async () => "allow",
    }), (e) => e?.name === "ProviderError" && e.code === "no-token");
    assert.equal(ran, 0, "nothing runs after a failed pin");
  }
});

// DEVOS-21 part 12: cycle 18 ended `purge-permission:coolify/application` with a key that has every permission box.
test("part 12: a resource refusal names the teardown stage and the 401/403 status, never the resource", () => {
  const app = { provider: "coolify", kind: "application", externalId: "uuid-secret-1", name: "devos-acme-preview" };
  const msg = (m) => Object.assign(terr("provider_forbidden", false, app), { message: m });
  for (const stage of ["lookup", "archive", "restore", "delete"]) {
    for (const st of ["401", "403"]) {
      const out = purgeStop(msg(`${stage} of coolify application devos-acme-preview (uuid-secret-1) was refused by coolify (http ${st}): the token lacks the permission`));
      assert.deepEqual(out, { error: `purge-permission:coolify/application:${stage}:http-${st}` });
      assert.ok(!out.error.includes("acme") && !out.error.includes("uuid-secret"));
    }
  }
  assert.deepEqual(purgeStop(msg("archive of x was refused by coolify: the token lacks the permission")), { error: "purge-permission:coolify/application:archive" }, "the older form: the stage alone");
  assert.deepEqual(purgeStop(msg("archive of x was refused by coolify (http 500): the token lacks the permission")), { error: "purge-permission:coolify/application:archive" }, "only 401/403 are named");
  assert.deepEqual(purgeStop(msg("archive of x was refused by coolify (http 403): the token lacks the permission and more")), { error: "purge-permission:coolify/application:archive" }, "the fixed ending is required");
  assert.deepEqual(purgeStop(msg("teardown refused: http 403")), { error: "purge-permission:coolify/application" }, "an unknown form names the kind only");
  assert.deepEqual(purgeStop(terr("provider_forbidden", false, { provider: "github", kind: "repo" })), { error: "purge-permission:github/repo" });
  assert.equal(forbiddenTail(undefined), "");
  assert.equal(forbiddenTail("purge preflight: coolify GET /api/v1/projects returned 403"), "");
});

test("part 12: the preflight and odd-kind refusals are unchanged", () => {
  assert.deepEqual(purgeStop(terr("provider_forbidden")), { error: "purge-permission:preflight" });
  const odd = Object.assign(terr("provider_forbidden", false, { provider: "coolify", kind: "Bad Kind!" }), { message: "archive of x was refused by coolify (http 403): the token lacks the permission" });
  assert.deepEqual(purgeStop(odd), { error: "purge-permission:resource" });
});
