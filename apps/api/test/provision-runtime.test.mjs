// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md "d1 runtime wiring"): the sweep's wiring, over a fake @devos/provision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProvisionSweep, policyAuthorizer, provisionConfig, PROVISIONER_IDENTITY } from "../dist/provision-runtime.js";

const ENV = {
  DEVOS_GITHUB_OWNER: "devos-bot",
  DEVOS_COOLIFY_URL: "http://devos-coolify:8000",
  DEVOS_COOLIFY_SERVER_UUID: "srv-1",
  DEVOS_TAILNET_IP: "100.64.0.7",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
};

function fakeModule(rec) {
  const step = (key) => ({ key });
  return {
    GitHubClient: class { constructor(o) { rec.ghToken = o.token; } },
    CoolifyClient: class { constructor(o) { rec.cfOrigin = o.origin; rec.cfToken = o.token; } },
    PrismaStore: class { constructor(db, o) { rec.storeUrl = o.databaseUrl; } async assertLockHeld(id) { rec.lockChecks.push(id); } },
    parsePortRange: (raw) => { if (raw === "bad") throw new Error("port-range-invalid"); return { start: 20000, end: 20999 }; },
    coreTemplateFiles: (apply, o) => { rec.coreSha = o.devosSha; return [{ path: ".devos/template.json" }]; },
    runProvision: async (id, steps, o) => { rec.runs.push({ id, keys: steps.map((s) => s.key), authorize: o.authorize }); return []; },
    githubRepoStep: (gh, p, owner) => { rec.repo = { p, owner }; return step("github/repo"); },
    githubCoreStep: (gh, p, owner, files, version, assertLock) => { rec.assertLock = assertLock; rec.coreVersion = version; return step("github/core"); },
    stackSteps: () => [step("coolify/project"), step("coolify/environment:preview")],
    deployKeySteps: () => [step("coolify/private_key"), step("github/deploy_key")],
    applicationSteps: (cf, gh, store, p, o) => { rec.appOpts = o; return [step("github/deploy_compose"), step("coolify/application:preview")]; },
    appSecretSteps: (cf, store, secrets) => { rec.secrets = secrets; return [step("coolify/app_secret:preview/SESSION_SECRET")]; },
  };
}

function wire(over = {}) {
  const rec = { runs: [], lockChecks: [], cards: [], logs: [], decided: [], vaultCalls: [] };
  const project = { id: "11111111-1111-4111-8111-111111111111", slug: "shop", name: "Shop" };
  const vault = {
    reveal: async (n) => { rec.vaultCalls.push(n); return n === "github_token" ? "gh-token-value" : null; },
    hasProject: async () => true,
    putProject: async (id, n) => { rec.vaultCalls.push(`put:${id}:${n}`); return { rotated: false }; },
    matchesProject: async () => true,
  };
  const policy = { decide: async (r) => { rec.decided.push(r); return { enforcedOutcome: over.outcome ?? "allow" }; } };
  const w = {
    mod: fakeModule(rec),
    apply: () => ({ code: 0 }),
    afterStack: async () => ({ compose: {} }),
    db: {},
    databaseUrl: "postgresql://x@localhost/devos",
    vault,
    policy,
    rows: { listProvisioning: async () => (rec.building ? [] : [project]), markBuilding: async (id) => { rec.building = id; } },
    raiseCard: async (c) => { rec.cards.push(c); },
    log: (e) => rec.logs.push(e),
    env: ENV,
    ...over.w,
  };
  return { rec, project, w, job: buildProvisionSweep(w) };
}

test("d1 wiring: the full step list runs in contract order, then the project moves to building", async () => {
  const { rec, project, job } = wire();
  assert.equal(typeof job.tick, "function");
  assert.equal(await job.tick(), 1);
  assert.deepEqual(rec.runs.map((r) => r.keys), [[
    "github/repo", "github/core", "coolify/project", "coolify/environment:preview", "coolify/private_key", "github/deploy_key",
    "github/deploy_compose", "coolify/application:preview", "coolify/app_secret:preview/SESSION_SECRET",
  ]]);
  assert.equal(rec.building, project.id);
  assert.deepEqual(rec.repo, { p: project, owner: "devos-bot" });
  assert.equal(rec.cfOrigin, "http://devos-coolify:8000");
  assert.equal(rec.coreSha, ENV.GIT_SHA);
  assert.deepEqual(rec.appOpts.serverUuid, "srv-1");
  assert.deepEqual(rec.appOpts.tailnetIp, "100.64.0.7");
  await rec.assertLock();
  assert.deepEqual(rec.lockChecks, [project.id], "the core step re-checks this project's lock");
});

test("d1 wiring: tokens come from the vault by name at call time; a missing one fails the call, never an empty token", async () => {
  const { rec, job } = wire();
  assert.deepEqual(rec.vaultCalls, [], "nothing is read at build time");
  assert.equal(await rec.ghToken(), "gh-token-value");
  await assert.rejects(rec.cfToken(), /coolify_api_token-not-set/);
  await job.tick();
  await rec.secrets.put("p", "preview/SESSION_SECRET", "v");
  assert.ok(rec.vaultCalls.includes("put:p:preview/SESSION_SECRET"), "app secrets go to the project-scoped vault");
});

test("d1 wiring (AT12): every create asks the policy engine as the provisioner; a deny is a deny", async () => {
  const { rec, job } = wire({ outcome: "deny" });
  await job.tick();
  const authorize = rec.runs[0].authorize;
  assert.equal(await authorize("provision.github.repo", "project:p/github/repo"), "deny");
  assert.deepEqual(rec.decided[0], { identity: PROVISIONER_IDENTITY, action: { type: "provision.github.repo", resource: "project:p/github/repo", projectId: "11111111-1111-4111-8111-111111111111" } });
  const ra = policyAuthorizer({ decide: async () => ({ enforcedOutcome: "require_approval" }) }, "p");
  assert.equal(await ra("a", "r"), "require_approval");
  const odd = policyAuthorizer({ decide: async () => ({ enforcedOutcome: "something-else" }) }, "p");
  assert.equal(await odd("a", "r"), "deny", "an unknown outcome fails closed");
});

test("d1 wiring: a name_conflict raises the rename-or-adopt card for that project and step", async () => {
  class StepError extends Error { constructor() { super("x"); this.name = "StepError"; this.step = "github/repo"; this.code = "name_conflict"; this.retryable = false; } }
  const { rec, w } = wire();
  w.mod.runProvision = async () => { throw new StepError(); };
  const job = buildProvisionSweep(w);
  await job.tick();
  assert.equal(rec.cards.length, 1);
  assert.equal(rec.cards[0].action, "provision.name_conflict");
  assert.equal(rec.cards[0].target, "project:11111111-1111-4111-8111-111111111111/github/repo");
});

test("d1 wiring: off, with a fixed code, without a vault or any required setting (fail closed, never allowAll)", () => {
  assert.deepEqual(wire({ w: { vault: null } }).job, { off: "provision-vault-not-configured" });
  const cases = [
    ["DEVOS_GITHUB_OWNER", "provision-github-owner-not-set"],
    ["DEVOS_COOLIFY_URL", "provision-coolify-url-not-set"],
    ["DEVOS_COOLIFY_SERVER_UUID", "provision-coolify-server-not-set"],
    ["DEVOS_TAILNET_IP", "provision-tailnet-ip-not-set"],
    ["GIT_SHA", "provision-devos-sha-unknown"],
  ];
  for (const [name, code] of cases) {
    const env = { ...ENV };
    delete env[name];
    assert.deepEqual(wire({ w: { env } }).job, { off: code }, name);
  }
  assert.deepEqual(provisionConfig({ ...ENV, GIT_SHA: "unknown" }), { off: "provision-devos-sha-unknown" });
  assert.deepEqual(provisionConfig({ ...ENV, DEVOS_COOLIFY_URL: "http://coolify:8000/api" }), { off: "provision-coolify-url-not-set" });
  assert.deepEqual(provisionConfig({ ...ENV, DEVOS_TAILNET_IP: "999.1.1.1" }), { off: "provision-tailnet-ip-not-set" });
  assert.deepEqual(wire({ w: { env: { ...ENV, DEVOS_PROJECT_PORTS: "bad" } } }).job, { off: "provision-port-range-invalid" });
});
