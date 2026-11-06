// M1.7 acceptance tests AT1–AT10 (docs/modules/M1.7.md) against the in-memory store.
// The Prisma store runs the same engine against Postgres in test-db/ (policy-db workflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  PolicyEngine,
  MemoryPolicyStore,
  envelopeWidening,
  delegateEnvelope,
  verifyLedger,
  usdToMicros,
  ceilMicroUsd,
} from "../dist/index.js";

const KEY = randomBytes(32);
const T0 = Date.parse("2026-11-06T10:00:00Z");
const HOUR = 3_600_000;
const KK = { identity: { id: "kk:kk@kiot.io", type: "kk" }, tailscaleLogin: "kk@kiot.io" };
const AGENT = { id: "agent:builder:run-1", type: "agent", roles: ["builder"] };

const rule = (id, effect, over = {}) => ({
  id, name: id, version: 1, priority: 0, actions: [], resources: [], principals: [], roles: [],
  environments: [], effect, constraints: {}, enabled: true, ...over,
});

function setup({ mode = "enforce", rules = [], budgets = [], now = () => T0 } = {}) {
  const store = new MemoryPolicyStore({ mode, rules });
  const engine = new PolicyEngine({ store, hmacKey: KEY, budgets, now, verifyKkSession: (s) => s.tailscaleLogin === "kk@kiot.io" });
  return { store, engine };
}

const root = (over = {}) => ({
  tools: ["Read", "Edit", "Bash"], readPaths: ["packages"], writePaths: ["packages/policy"], network: true,
  networkAllowList: "registry.npmjs.org,api.github.com", maxCostUsd: 5, maxTokens: 100_000, maxConcurrency: 4,
  expiresAt: T0 + 2 * HOUR, depth: 0, ...over,
});

test("AT1: deny overrides allow and approval (even with a valid grant)", async () => {
  const { engine } = setup({ rules: [rule("allow-all", "allow", { actions: ["git.push"] }), rule("needs-kk", "require_approval", { actions: ["git.push"] }), rule("no-main", "deny", { actions: ["git.push"], resources: ["main"] })] });
  const grant = await engine.issueGrant(KK, { scopeAction: "git.push", expiresAt: new Date(T0 + HOUR) });
  const d = await engine.decide({ identity: AGENT, action: { type: "git.push", resource: "main" }, approvalGrantId: grant.id });
  assert.equal(d.outcome, "deny");
  assert.equal(d.enforcedOutcome, "deny");
  assert.equal(d.reason, "denied-by:no-main");
  assert.equal(d.approvalGrantId, null);
  assert.equal(d.stop, "policy_denied");
  const other = await engine.decide({ identity: AGENT, action: { type: "git.push", resource: "feature" } });
  assert.equal(other.outcome, "require_approval", "approval beats allow");
});

test("AT2: unmatched action — observe allows and records would-deny; enforce denies", async () => {
  const obs = setup({ mode: "observe" });
  const d1 = await obs.engine.decide({ identity: AGENT, action: { type: "fs.delete", resource: "x" } });
  assert.deepEqual([d1.outcome, d1.enforcedOutcome, d1.wouldBlock, d1.reason, d1.stop], ["deny", "allow", true, "default-deny", null]);
  const row = obs.store.decisions.at(-1);
  assert.equal(row.outcome, "deny");
  assert.equal(row.enforcedOutcome, "allow");
  assert.equal(row.action.mode, "observe");
  const enf = setup({ mode: "enforce" });
  const d2 = await enf.engine.decide({ identity: AGENT, action: { type: "fs.delete", resource: "x" } });
  assert.deepEqual([d2.outcome, d2.enforcedOutcome, d2.wouldBlock, d2.stop], ["deny", "deny", false, "policy_denied"]);
});

test("AT3: a child envelope cannot widen any dimension", () => {
  const p = root();
  const ok = { ...root({ tools: ["Read"], readPaths: ["packages/policy"], writePaths: ["packages/policy/src"], networkAllowList: "api.github.com", maxCostUsd: 1, maxTokens: 10, maxConcurrency: 1, expiresAt: T0 + HOUR, depth: 1 }) };
  assert.deepEqual(envelopeWidening(p, ok), []);
  const cases = {
    tools: { tools: ["Read", "WebFetch"] },
    readPaths: { readPaths: ["apps"] },
    writePaths: { writePaths: ["packages/policyX"] },
    network: { networkAllowList: "evil.example" },
    maxCostUsd: { maxCostUsd: 5.01 },
    maxTokens: { maxTokens: 100_001 },
    maxConcurrency: { maxConcurrency: 5 },
    expiresAt: { expiresAt: T0 + 3 * HOUR },
    depth: { depth: 0 },
  };
  for (const [dim, over] of Object.entries(cases)) {
    assert.deepEqual(envelopeWidening(p, { ...ok, ...over }), [dim], dim);
  }
  assert.deepEqual(envelopeWidening(root({ network: false, networkAllowList: null }), { ...ok, network: true, networkAllowList: null }), ["network"]);
  assert.deepEqual(envelopeWidening(p, { ...ok, network: true, networkAllowList: null }), ["network"], "unrestricted under a list widens");
  assert.deepEqual(envelopeWidening(p, { ...ok, readPaths: ["packages/../apps"] }), ["readPaths"], "traversal");
  assert.deepEqual(envelopeWidening(root({ depth: 3 }), { ...ok, depth: 4 }), ["depth"], "max depth");
  assert.throws(() => delegateEnvelope(p, { ...ok, maxTokens: 1e9 }), /envelope-cannot-widen:maxTokens/);
  assert.equal(delegateEnvelope(p, ok).depth, 1);
});

test("AT4: self-approval, expired, revoked and over-maxUses grants all fail", async () => {
  let now = T0;
  const { engine, store } = setup({ rules: [rule("deploy-needs-kk", "require_approval", { actions: ["deploy.production"] })], now: () => now });
  const ask = (identity, grant) => engine.decide({ identity, action: { type: "deploy.production", resource: "devos" }, approvalGrantId: grant.id });

  // Issuance: an agent, or an unverified KK session, cannot issue.
  await assert.rejects(engine.issueGrant({ identity: AGENT, tailscaleLogin: "x" }, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) }), /grant-issuer-not-kk/);
  await assert.rejects(engine.issueGrant({ ...KK, tailscaleLogin: "mallory@x" }, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) }), /unverified/);
  await assert.rejects(engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + 91 * 24 * HOUR) }), /grant-expiry-invalid/);

  const self = await engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) });
  const dSelf = await ask(KK.identity, self);
  assert.equal(dSelf.outcome, "require_approval");
  assert.match(dSelf.reason, /grant-self-approval/);

  const once = await engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR), maxUses: 1 });
  assert.equal((await ask(AGENT, once)).outcome, "allow", "first use works");
  const used = await ask(AGENT, once);
  assert.equal(used.outcome, "require_approval");
  assert.match(used.reason, /grant-used-up/);
  assert.equal(store.grants.find((g) => g.id === once.id).uses, 1);

  const revoked = await engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) });
  assert.equal(await engine.revokeGrant(KK, revoked.id), true);
  assert.match((await ask(AGENT, revoked)).reason, /grant-revoked/);

  const expiring = await engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) });
  now = T0 + HOUR;
  assert.match((await ask(AGENT, expiring)).reason, /grant-expired/);

  now = T0;
  const scoped = await engine.issueGrant(KK, { scopeAction: "deploy.production", projectId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(T0 + HOUR) });
  assert.match((await ask(AGENT, scoped)).reason, /grant-scope-project/);
});

test("AT5: a budgeted request with no cost or token figure is denied (observe mode too)", async () => {
  const { engine } = setup({ mode: "observe", rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "anthropic-cap", provider: "anthropic", maxCostUsd: 15, maxTokens: 1e9 }] });
  const noCost = await engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", tokens: 100 } });
  assert.deepEqual([noCost.outcome, noCost.enforcedOutcome, noCost.reason, noCost.stop], ["deny", "deny", "budget-metering-required:costUsd", "budget_exceeded"]);
  const noTokens = await engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", costUsd: 0.1 } });
  assert.equal(noTokens.reason, "budget-metering-required:tokens");
  assert.equal(noTokens.enforcedOutcome, "deny");
  const ok = await engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "anthropic", costUsd: 0.1, tokens: 100 } });
  assert.equal(ok.enforcedOutcome, "allow");
  assert.ok(ok.reservationId);
});

test("AT6: 20 concurrent budget decisions never exceed the ceiling; reconcile frees the difference", async () => {
  const { engine, store } = setup({ rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "cap", provider: "openai", maxCostUsd: 1, maxTokens: 1e9 }] });
  const call = () => engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd: 0.15, tokens: 10 } });
  const results = await Promise.all(Array.from({ length: 20 }, call));
  const allowed = results.filter((r) => r.enforcedOutcome === "allow");
  assert.equal(allowed.length, 6, "floor(1 / 0.15) = 6");
  assert.ok(results.filter((r) => r.enforcedOutcome === "deny").every((r) => r.reason === "budget-exceeded:cap"));
  const reserved = store.reservations.filter((r) => r.status === "reserved").reduce((s, r) => s + r.reservedUsd, 0);
  assert.ok(reserved <= 1 + 1e-9, `reserved ${reserved}`);
  await engine.reconcile(allowed[0].reservationId, 0.05, 5);
  await engine.release(allowed[1].reservationId);
  const after = await call();
  assert.equal(after.enforcedOutcome, "allow", "reconciled + released headroom is reusable");
  await assert.rejects(engine.reconcile(allowed[0].reservationId, 1, 1), /reservation-not-open/);
});

test("AT7: changing one byte of any receipt fails ledger verification", async () => {
  const { engine, store } = setup({ mode: "observe", rules: [rule("a", "allow", { actions: ["x"] })] });
  for (let i = 0; i < 5; i++) await engine.decide({ identity: AGENT, action: { type: i % 2 ? "x" : "y", resource: `r${i}` } });
  assert.deepEqual(await engine.verify(), { valid: true, length: 5 });
  const rows = await store.readChain("main");
  const mutations = [
    (r) => { r.identity.id = r.identity.id.replace("1", "2"); },
    (r) => { r.action.request.resource += "!"; },
    (r) => { r.outcome = r.outcome === "allow" ? "deny" : "allow"; },
    (r) => { r.enforcedOutcome = "deny"; },
    (r) => { r.matchedRuleIds = [...r.matchedRuleIds, "z"]; },
    (r) => { r.bundleHash = r.bundleHash.replace(/.$/, (c) => (c === "0" ? "1" : "0")); },
    (r) => { r.ts = new Date(r.ts.getTime() + 1); },
    (r) => { r.hash = r.hash.replace(/^./, (c) => (c === "0" ? "1" : "0")); },
    (r) => { r.hmac = r.hmac.replace(/^./, (c) => (c === "0" ? "1" : "0")); },
    (r) => { r.prevHash = "0".repeat(64); },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const copy = structuredClone(rows);
    mutate(copy[2]);
    const v = verifyLedger(copy, KEY);
    assert.equal(v.valid, false, `mutation ${i}`);
  }
  assert.equal(verifyLedger(rows.slice(1), KEY).valid, false, "dropped receipt");
  assert.equal(verifyLedger(rows, randomBytes(32)).valid, false, "wrong HMAC key");
  assert.throws(() => new PolicyEngine({ store, hmacKey: Buffer.alloc(16) }), /policy-hmac-key-too-short/);
});

test("AT8: the decision is persisted before the caller receives allow; a failed write never allows", async () => {
  const { engine, store } = setup({ rules: [rule("a", "allow", { actions: ["x"] })] });
  const d = await engine.decide({ identity: AGENT, action: { type: "x" } });
  assert.equal(d.enforcedOutcome, "allow");
  const row = store.decisions.at(-1);
  assert.equal(row.hash, d.receipt.hash, "row committed when decide resolves");

  const failing = new MemoryPolicyStore({ mode: "enforce", rules: [rule("a", "allow", { actions: ["x"] })] });
  const realDecide = failing.decide.bind(failing);
  failing.decide = (fn) => realDecide((tx) => fn({ ...tx, insertDecision: async () => { throw new Error("disk full"); } }));
  const e2 = new PolicyEngine({ store: failing, hmacKey: KEY, now: () => T0 });
  await assert.rejects(e2.decide({ identity: AGENT, action: { type: "x" } }), /disk full/);
  assert.equal(failing.decisions.length, 0);

  // A reservation made in a failed decision is rolled back with it.
  const f2 = new MemoryPolicyStore({ mode: "enforce", rules: [rule("a", "allow", { actions: ["llm"] })] });
  const real2 = f2.decide.bind(f2);
  f2.decide = (fn) => real2((tx) => fn({ ...tx, insertDecision: async () => { throw new Error("down"); } }));
  const e3 = new PolicyEngine({ store: f2, hmacKey: KEY, now: () => T0, budgets: [{ id: "c", maxCostUsd: 1, maxTokens: 10 }] });
  await assert.rejects(e3.decide({ identity: AGENT, action: { type: "llm", budgeted: true, provider: "openai", costUsd: 0.5, tokens: 1 } }));
  assert.equal(f2.reservations.length, 0);
});

test("AT9: gates and envelope violations are enforced in observe mode", async () => {
  const { engine } = setup({ mode: "observe", rules: [
    rule("g4-release", "require_approval", { actions: ["deploy.production"], constraints: { gate: true } }),
    rule("pretooluse-deny", "deny", { actions: ["tool.bash"], resources: ["rm -rf*"], constraints: { gate: true } }),
    rule("plain", "deny", { actions: ["note.write"] }),
  ] });
  const gate = await engine.decide({ identity: AGENT, action: { type: "deploy.production" } });
  assert.deepEqual([gate.outcome, gate.enforcedOutcome, gate.wouldBlock], ["require_approval", "require_approval", false]);
  const hook = await engine.decide({ identity: AGENT, action: { type: "tool.bash", resource: "rm -rf /" } });
  assert.equal(hook.enforcedOutcome, "deny");
  const plain = await engine.decide({ identity: AGENT, action: { type: "note.write" } });
  assert.equal(plain.enforcedOutcome, "allow", "non-gate rule only observed");
  const envelope = root();
  for (const action of [
    { type: "fs.write", writePaths: ["apps/api/x.ts"] },
    { type: "tool", tool: "WebFetch" },
    { type: "net", network: true, host: "evil.example" },
    { type: "llm", costUsd: 6 },
  ]) {
    const d = await engine.decide({ identity: AGENT, action, envelope });
    assert.equal(d.enforcedOutcome, "deny", JSON.stringify(action));
    assert.match(d.reason, /outside-envelope/);
  }
  const expired = await engine.decide({ identity: AGENT, action: { type: "x" }, envelope: root({ expiresAt: T0 }) });
  assert.deepEqual([expired.enforcedOutcome, expired.reason], ["deny", "envelope-expired"]);
});

test("AT9 (PR13-r1): a non-gate rule cannot mask a gate in observe mode", async () => {
  const { engine } = setup({ mode: "observe", rules: [
    rule("plain-deny", "deny", { actions: ["deploy.production"], priority: 10 }),
    rule("g4-approval", "require_approval", { actions: ["deploy.production"], constraints: { gate: true } }),
    rule("plain-deny-hi", "deny", { actions: ["tool.bash"], priority: 10 }),
    rule("hook-deny", "deny", { actions: ["tool.bash"], constraints: { gate: true } }),
  ] });
  const masked = await engine.decide({ identity: AGENT, action: { type: "deploy.production" } });
  assert.deepEqual([masked.outcome, masked.enforcedOutcome], ["deny", "require_approval"]);
  assert.match(masked.reason, /gate-approval-required-by:g4-approval/);
  const grant = await engine.issueGrant(KK, { scopeAction: "deploy.production", expiresAt: new Date(T0 + HOUR) });
  const lifted = await engine.decide({ identity: AGENT, action: { type: "deploy.production" }, approvalGrantId: grant.id });
  assert.deepEqual([lifted.outcome, lifted.enforcedOutcome, lifted.wouldBlock, lifted.approvalGrantId], ["deny", "allow", true, grant.id]);
  const hook = await engine.decide({ identity: AGENT, action: { type: "tool.bash" } });
  assert.deepEqual([hook.outcome, hook.enforcedOutcome, hook.stop], ["deny", "deny", "policy_denied"]);
  assert.match(hook.reason, /gate-denied-by:hook-deny/);
});

test("AT6 (PR13-r1): sub-micro-dollar costs round up, so repeated calls cannot pass a ceiling at zero", async () => {
  const { engine, store } = setup({ rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "tiny", provider: "openai", maxCostUsd: 0.000001, maxTokens: 1e9 }] });
  const call = () => engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd: 0.0000004, tokens: 0 } });
  assert.equal((await call()).enforcedOutcome, "allow");
  assert.equal(store.reservations[0].reservedUsd, 0.000001);
  const second = await call();
  assert.deepEqual([second.enforcedOutcome, second.reason], ["deny", "budget-exceeded:tiny"]);
  await engine.reconcile(store.reservations[0].id, 0.0000001, 0);
  assert.equal(store.reservations[0].actualUsd, 0.000001, "actuals round up too");
  assert.equal((await call()).enforcedOutcome, "deny");
  await assert.rejects(engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd: 0, tokens: 1.5 } }), /invalid-policy-action-tokens/);
});

test("AT6 (PR13-r2): micro-dollar conversion is exact at the boundaries", async () => {
  const cases = [
    [0.0000000001, "ceil", 1], [0.0000010001, "ceil", 2], [0.0000009999, "floor", 0], [0.0000009999, "ceil", 1],
    [0.15, "ceil", 150000], [0.15, "floor", 150000], [0.1, "ceil", 100000], [1, "floor", 1000000], [0, "ceil", 0],
    [15, "floor", 15000000], [1e-7, "ceil", 1], [1e-7, "floor", 0], [123456.0000001, "ceil", 123456000001],
  ];
  for (const [usd, dir, want] of cases) assert.equal(usdToMicros(usd, dir), want, `${usd} ${dir}`);
  assert.equal(ceilMicroUsd(0.0000010001), 0.000002);
  assert.throws(() => usdToMicros(-1, "ceil"), /invalid-usd-amount/);
  // A ceiling below one micro-dollar allows nothing; a 1e-10 call reserves a full micro-dollar.
  const { engine, store } = setup({ rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "sub-micro", provider: "openai", maxCostUsd: 0.0000009999, maxTokens: 1e9 }] });
  const d = await engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd: 0.0000000001, tokens: 0 } });
  assert.deepEqual([d.enforcedOutcome, d.reason], ["deny", "budget-exceeded:sub-micro"]);
  const two = setup({ rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "c", provider: "openai", maxCostUsd: 1, maxTokens: 1e9 }] });
  await two.engine.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd: 0.0000000001, tokens: 0 } });
  assert.equal(two.store.reservations[0].reservedUsd, 0.000001);
  await two.engine.reconcile(two.store.reservations[0].id, 0.0000010001, 0);
  assert.equal(two.store.reservations[0].actualUsd, 0.000002);
  assert.equal(store.reservations.length, 0);
});

test("rules (PR13-r3): only the highest enabled version of a rule is in force, in every store", async () => {
  const { engine } = setup({ rules: [
    rule("r1", "deny", { name: "push-policy", version: 1, actions: ["git.push"] }),
    rule("r2", "allow", { name: "push-policy", version: 2, actions: ["git.push"] }),
    rule("r3", "allow", { name: "off", version: 3, actions: ["x"], enabled: false }),
    rule("r4", "deny", { name: "off", version: 1, actions: ["x"] }),
  ] });
  const d = await engine.decide({ identity: AGENT, action: { type: "git.push" } });
  assert.deepEqual([d.outcome, d.matchedRuleIds], ["allow", ["r2"]]);
  const x = await engine.decide({ identity: AGENT, action: { type: "x" } });
  assert.deepEqual([x.outcome, x.matchedRuleIds], ["deny", ["r4"]], "a disabled newer version does not revive or hide the older one");
});

test("PR13-r4: memory-store reconcile/release/revoke wait for an in-flight decision and survive its rollback", async () => {
  const { engine, store } = setup({ rules: [rule("llm", "allow", { actions: ["llm.call"] })], budgets: [{ id: "cap", provider: "openai", maxCostUsd: 1, maxTokens: 1e9 }] });
  const ask = (e, costUsd) => e.decide({ identity: AGENT, action: { type: "llm.call", budgeted: true, provider: "openai", costUsd, tokens: 1 } });
  const first = await ask(engine, 0.2);
  const realDecide = store.decide.bind(store);
  let release;
  const paused = new Promise((r) => { release = r; });
  let reached;
  const inUsage = new Promise((r) => { reached = r; });
  store.decide = (fn) => realDecide((tx) => fn({ ...tx, usage: async (f) => { const u = await tx.usage(f); reached(); await paused; return u; } }));
  const pending = ask(engine, 0.5);
  await inUsage;
  let done = false;
  const rec = engine.reconcile(first.reservationId, 0.9, 1).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, "reconcile waits for the decision");
  release();
  assert.equal((await pending).enforcedOutcome, "allow", "0.2 + 0.5 <= 1 when decided");
  await rec;
  store.decide = realDecide;
  assert.equal((await ask(engine, 0.000001)).enforcedOutcome, "deny", "0.9 + 0.5 is at the cap: nothing more fits");

  // A failed decision's rollback cannot undo a revocation made while it waited.
  const grant = await engine.issueGrant(KK, { scopeAction: "x", expiresAt: new Date(T0 + HOUR) });
  let go;
  const gate = new Promise((r) => { go = r; });
  store.decide = (fn) => realDecide(async (tx) => { await gate; throw new Error("boom"); });
  const failing = engine.decide({ identity: AGENT, action: { type: "x" } }).catch((e) => e);
  const revoked = engine.revokeGrant(KK, grant.id);
  go();
  assert.match(String(await failing), /boom/);
  assert.equal(await revoked, true);
  assert.ok(store.grants.find((g) => g.id === grant.id).revokedAt, "revocation kept");
});

test("PR13-r4: a host-bearing action is network use for rule constraints too", async () => {
  const { engine } = setup({ rules: [rule("offline-only", "allow", { actions: ["fetch"], constraints: { network: false } })] });
  assert.equal((await engine.decide({ identity: AGENT, action: { type: "fetch", host: "example.com" } })).outcome, "deny");
  assert.equal((await engine.decide({ identity: AGENT, action: { type: "fetch", network: true } })).outcome, "deny");
  assert.equal((await engine.decide({ identity: AGENT, action: { type: "fetch" } })).outcome, "allow");
});

test("AT10: THIRD_PARTY_NOTICES.md and the per-file headers are present", () => {
  const repo = new URL("../../../", import.meta.url);
  const notices = new URL("THIRD_PARTY_NOTICES.md", repo);
  assert.ok(existsSync(notices));
  const text = readFileSync(notices, "utf8");
  assert.match(text, /ruvnet\/ruflo/);
  assert.match(text, /a3d45e64b9ce66d3a172c8051e8b20561321eb64/);
  assert.match(text, /MIT License/);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const adapted = { "canonical.ts": "canonical.ts", "envelope.ts": "envelope.ts", "evaluator.ts": "evaluator.ts", "engine.ts": "engine.ts", "receipts.ts": "engine.ts" };
  for (const [file, source] of Object.entries(adapted)) {
    const head = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").split("\n").slice(0, 4).join("\n");
    assert.match(head, /Adapted from ruflo \(https:\/\/github\.com\/ruvnet\/ruflo\), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64/, file);
    assert.ok(head.includes(`v3/@claude-flow/security/src/policy/${source}`), file);
    assert.match(head, /MIT License, Copyright \(c\) 2024-2026 ruvnet/, file);
  }
  // Not lifted (DEVOS-57): product-plane, MetaHarness, federation, CLI.
  const all = ["canonical", "envelope", "evaluator", "engine", "receipts", "store", "prisma-store", "types", "index"]
    .map((f) => readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(all, /product-plane|MetaHarness|federation/i);
});
