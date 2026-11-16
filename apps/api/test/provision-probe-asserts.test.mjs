// DEVOS-234 (M2.4-d3c-2b, docs/modules/M2.4.md "M2.4-d3c-2b decisions"): AT13's live asserts over the recorded ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realProvision from "@devos/provision";
import { probeLiveAsserts, composeMatches, envPhase, capCodes, readProbeSteps, COOLIFY_DESCRIPTION_MAX, ASSERT_DETAIL_MAX } from "../dist/provision-probe-asserts.js";
import { probeStep } from "../dist/provision-probe.js";
import { safeDetail } from "../dist/provision-probe-cli.js";

const PID = "11111111-1111-4111-8111-111111111111";
const MARKER = `devos:${PID}`;
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const APP = { preview: "app-preview-uuid", production: "app-live-uuid" };
const compose = (env) => Buffer.from(`services:\n  app:\n    image: core-${env}\n    ports:\n      - target: 3000\n`, "utf8");
const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

function steps(over = {}) {
  return new Map(Object.entries({
    "github/repo": "kk/devos-devos-probe-m24",
    "github/deploy_compose": COMMIT,
    "coolify/application/preview": APP.preview,
    "coolify/application/production": APP.production,
    ...over,
  }).filter(([, v]) => v !== undefined));
}

const goodEnv = (key, extra = {}) => ({ key, value: "secret-value-not-printed", is_preview: false, is_build_time: false, ...extra });

/** A fake world: GitHub and Coolify answer from `routes`; every path read is recorded; a value of Error is thrown. */
function world(over = {}) {
  const blobs = Object.fromEntries(["preview", "production"].map((e) => [blobSha(compose(e)), compose(e)]));
  const routes = {
    "gh:/repos/kk/devos-devos-probe-m24": { status: 200, body: { default_branch: "main", private: true } },
    [`gh:/repos/kk/devos-devos-probe-m24/git/commits/${COMMIT}`]: { status: 200, body: { tree: { sha: TREE } } },
    [`gh:/repos/kk/devos-devos-probe-m24/git/trees/${TREE}?recursive=1`]: {
      status: 200,
      body: { truncated: false, tree: ["preview", "production"].map((e) => ({ path: `deploy/compose.${e}.devos.yaml`, type: "blob", mode: "100644", sha: blobSha(compose(e)) })) },
    },
    ...Object.fromEntries(Object.entries(blobs).map(([sha, buf]) => [`gh:/repos/kk/devos-devos-probe-m24/git/blobs/${sha}`, { status: 200, body: { encoding: "base64", content: buf.toString("base64") } }])),
    ...Object.fromEntries(["preview", "production"].flatMap((e) => [
      [`cf:/api/v1/applications/${APP[e]}`, { status: 200, body: { description: `DevOS devos-probe-m24 ${e === "production" ? "live" : "preview"} stack ${MARKER}`, docker_compose_raw: compose(e).toString("utf8") } }],
      [`cf:/api/v1/applications/${APP[e]}/envs`, { status: 200, body: [goodEnv("SESSION_SECRET"), goodEnv("DB_PASSWORD"), { key: "SESSION_SECRET", value: null, is_preview: true }] }],
    ])),
    ...over,
  };
  const reads = [];
  const http = (p) => ({
    get: async (path) => {
      reads.push(`${p}:${path}`);
      const r = routes[`${p}:${path}`];
      if (r instanceof Error) throw r;
      return r ?? { status: 404, body: null };
    },
  });
  const pins = [];
  const mod = {
    ...realProvision,
    pinnedGitHub: async (gh) => { pins.push(["gh", gh]); return { http: http("gh") }; },
    pinnedCoolify: async (cf) => { pins.push(["cf", cf]); return { http: http("cf") }; },
  };
  return { mod, reads, pins };
}

const run = (w, s = steps()) => probeLiveAsserts({ mod: w.mod, gh: "GH", cf: "CF", projectId: PID, steps: async () => s });

test("d3c-2b: every assert passes on a correctly provisioned probe, with GET reads only on the pinned clients", async () => {
  const w = world();
  assert.deepEqual(await run(w), []);
  assert.deepEqual(w.pins, [["gh", "GH"], ["cf", "CF"]]);
  assert.ok(w.reads.includes("gh:/repos/kk/devos-devos-probe-m24"));
  for (const e of ["preview", "production"]) {
    assert.ok(w.reads.includes(`cf:/api/v1/applications/${APP[e]}`));
    assert.ok(w.reads.includes(`cf:/api/v1/applications/${APP[e]}/envs`));
  }
  // The tree of the journalled commit is read once for both environments.
  assert.equal(w.reads.filter((r) => r.includes("/git/commits/")).length, 1);
});

test("d3c-2b: default branch not main, and unreadable", async () => {
  assert.deepEqual(await run(world({ "gh:/repos/kk/devos-devos-probe-m24": { status: 200, body: { default_branch: "master" } } })), ["default-branch-not-main"]);
  assert.deepEqual(await run(world({ "gh:/repos/kk/devos-devos-probe-m24": new Error("github 500 with a provider body") })), ["default-branch-unreadable"]);
  assert.deepEqual(await run(world({ "gh:/repos/kk/devos-devos-probe-m24": { status: 404, body: null } })), ["default-branch-unreadable"]);
});

test("d3c-2b: the app description must keep the marker and fit Coolify's limit", async () => {
  const app = (description) => ({ status: 200, body: { description, docker_compose_raw: compose("preview").toString("utf8") } });
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.preview}`]: app("DevOS devos-probe-m24 preview stack devos:") })), ["app-description-marker:preview"]);
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.preview}`]: app(null) })), ["app-description-marker:preview"]);
  const long = `${"x".repeat(COOLIFY_DESCRIPTION_MAX)} ${MARKER}`;
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.preview}`]: app(long) })), ["app-description-length:preview"]);
  const exact = `${"x".repeat(COOLIFY_DESCRIPTION_MAX - MARKER.length)}${MARKER}`;
  assert.equal(exact.length, COOLIFY_DESCRIPTION_MAX);
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.preview}`]: app(exact) })), []);
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.production}`]: new Error("coolify 502 body") })), ["app-unreadable:production"]);
});

test("d3c-2b: the stored Compose must equal the committed file at the journalled commit", async () => {
  const raw = (r) => ({ [`cf:/api/v1/applications/${APP.preview}`]: { status: 200, body: { description: `x ${MARKER}`, docker_compose_raw: r } } });
  assert.deepEqual(await run(world(raw(compose("production").toString("utf8")))), ["app-compose-differs:preview"]);
  assert.deepEqual(await run(world(raw(null))), ["app-compose-differs:preview"]);
  // Stored as sent (base64) or re-serialized (same document, other key order and layout) both match.
  assert.deepEqual(await run(world(raw(compose("preview").toString("base64")))), []);
  assert.deepEqual(await run(world(raw("services: {app: {ports: [{target: 3000}], image: core-preview}}\n"))), []);
  // The file missing from the commit's tree differs; an unreadable tree is its own code.
  const w = world({ [`gh:/repos/kk/devos-devos-probe-m24/git/trees/${TREE}?recursive=1`]: { status: 200, body: { truncated: false, tree: [] } } });
  assert.deepEqual(await run(w), ["app-compose-differs:preview", "app-compose-differs:production"]);
  const w2 = world({ [`gh:/repos/kk/devos-devos-probe-m24/git/commits/${COMMIT}`]: new Error("github body") });
  assert.deepEqual(await run(w2), ["compose-unreadable:preview", "compose-unreadable:production"]);
  // A blob whose content does not match its id (CoreRepo's check) is unreadable, never "equal".
  const bad = blobSha(compose("preview"));
  const w3 = world({ [`gh:/repos/kk/devos-devos-probe-m24/git/blobs/${bad}`]: { status: 200, body: { encoding: "base64", content: Buffer.from("tampered").toString("base64") } } });
  assert.deepEqual(await run(w3), ["compose-unreadable:preview"]);
});

test("d3c-2b: each app secret's env var is listed, readable and runtime-only", async () => {
  const envs = (list) => ({ [`cf:/api/v1/applications/${APP.production}/envs`]: { status: 200, body: list } });
  // Missing, preview-only, null or empty value: not readable.
  assert.deepEqual(await run(world(envs([goodEnv("SESSION_SECRET")]))), ["env-not-readable:production/DB_PASSWORD"]);
  assert.deepEqual(await run(world(envs([goodEnv("SESSION_SECRET"), goodEnv("DB_PASSWORD", { is_preview: true })]))), ["env-not-readable:production/DB_PASSWORD"]);
  assert.deepEqual(await run(world(envs([goodEnv("SESSION_SECRET", { value: null }), goodEnv("DB_PASSWORD", { value: "" })]))), ["env-not-readable:production/DB_PASSWORD", "env-not-readable:production/SESSION_SECRET"]);
  // Build-time under each release's flag names; no flag at all cannot be confirmed.
  assert.deepEqual(await run(world(envs([goodEnv("SESSION_SECRET", { is_build_time: true }), goodEnv("DB_PASSWORD")]))), ["env-build-time:production/SESSION_SECRET"]);
  const newer = (k, o) => ({ key: k, value: "v", is_preview: false, ...o });
  assert.deepEqual(await run(world(envs([newer("SESSION_SECRET", { is_buildtime: true, is_runtime: true }), newer("DB_PASSWORD", { is_runtime: false, is_buildtime: false })]))), ["env-build-time:production/DB_PASSWORD", "env-build-time:production/SESSION_SECRET"]);
  assert.deepEqual(await run(world(envs([newer("SESSION_SECRET", { is_buildtime: false, is_runtime: true }), newer("DB_PASSWORD", {})]))), ["env-build-time-unknown:production/DB_PASSWORD"]);
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.production}/envs`]: { status: 200, body: { not: "a list" } } })), ["env-unreadable:production"]);
  assert.deepEqual(await run(world({ [`cf:/api/v1/applications/${APP.production}/envs`]: new Error("coolify body") })), ["env-unreadable:production"]);
});

test("d3c-2b: no value or provider body ever appears in the result", async () => {
  const secret = "SECRET-VALUE-9f8e7d";
  const w = world({
    "gh:/repos/kk/devos-devos-probe-m24": new Error(`github 500 ${secret}`),
    [`cf:/api/v1/applications/${APP.preview}`]: { status: 200, body: { description: secret, docker_compose_raw: secret } },
    [`cf:/api/v1/applications/${APP.preview}/envs`]: { status: 200, body: [goodEnv("SESSION_SECRET", { value: secret, is_build_time: true })] },
  });
  const out = await run(w);
  assert.ok(out.length > 0);
  assert.ok(!JSON.stringify(out).includes(secret));
  for (const c of out) assert.match(c, /^[a-z0-9-]+(:[a-z]+(\/[A-Z_]+)?|:[a-z_]+\/[a-z_]+)?$/);
});

test("d3c-2b: only recorded ids are used; a missing or malformed journal row is its own code and reads nothing for it", async () => {
  const w = world();
  assert.deepEqual(await run(w, steps({ "coolify/application/preview": undefined })), ["journal-missing:coolify/application/preview"]);
  assert.ok(!w.reads.some((r) => r.includes(APP.preview)));
  const w2 = world();
  assert.deepEqual(await run(w2, steps({ "github/repo": "../user" })), ["journal-missing:github/repo"]);
  assert.ok(!w2.reads.some((r) => r.startsWith("gh:")));
  const w3 = world();
  assert.deepEqual(await run(w3, steps({ "github/repo": "../x" })), ["journal-missing:github/repo"]);
  assert.ok(!w3.reads.some((r) => r.startsWith("gh:")));
  const w4 = world();
  assert.deepEqual(await run(w4, steps({ "coolify/application/production": "../../keys" })), ["journal-missing:coolify/application/production"]);
  assert.ok(!w4.reads.some((r) => r.includes("keys")));
  assert.deepEqual(await run(world(), steps({ "github/deploy_compose": "not-a-sha" })), ["journal-missing:github/deploy_compose"]);
});

test("d3c-2b: the joined codes fit the printed detail, with a count of the rest", async () => {
  assert.deepEqual(capCodes(["b", "a", "b"]), ["a", "b"]);
  const many = Array.from({ length: 30 }, (_, i) => `env-build-time-unknown:production/K${String(i).padStart(2, "0")}`);
  const out = capCodes(many);
  assert.ok(out.join(",").length <= ASSERT_DETAIL_MAX);
  assert.match(out.at(-1), /^more-\d+$/);
  assert.equal(out.length - 1 + Number(out.at(-1).slice(5)), 30);
  assert.equal(safeDetail(out.join(",")), out.join(","));
  // Every assert failing at once still prints.
  const w = world({
    "gh:/repos/kk/devos-devos-probe-m24": { status: 200, body: { default_branch: "dev" } },
    ...Object.fromEntries(["preview", "production"].flatMap((e) => [
      [`cf:/api/v1/applications/${APP[e]}`, { status: 200, body: { description: "y".repeat(300), docker_compose_raw: "z" } }],
      [`cf:/api/v1/applications/${APP[e]}/envs`, { status: 200, body: [] }],
    ])),
  });
  const all = await run(w);
  assert.ok(all.join(",").length <= ASSERT_DETAIL_MAX);
  assert.equal(safeDetail(all.join(",")), all.join(","));
});

test("d3c-2b: helpers", () => {
  assert.equal(envPhase({ is_build_time: false }), "runtime");
  assert.equal(envPhase({ is_runtime: true }), "runtime");
  assert.equal(envPhase({ is_build_time: "false" }), "unknown");
  assert.equal(composeMatches("", Buffer.from(""), realProvision.parseCompose), false);
  assert.equal(composeMatches("not: [valid", Buffer.from("a: 1\n"), realProvision.parseCompose), false);
});

test("d3c-2b: the journal read is one bounded transaction over done rows only", async () => {
  const seen = [];
  const db = {
    $transaction: async (fn, opts) => {
      seen.push(opts);
      return fn({ provisionStep: { findMany: async (q) => { seen.push(q); return [{ key: "github/repo", externalId: "kk/r" }, { key: "x", externalId: null }]; } } });
    },
  };
  const m = await readProbeSteps(db, PID, 1234);
  assert.deepEqual([...m], [["github/repo", "kk/r"]]);
  assert.deepEqual(seen[0], { timeout: 1234, maxWait: 1234 });
  assert.deepEqual(seen[1].where, { projectId: PID, status: "done" });
});

test("d3c-2b: in probeStep, failing asserts purge and end live-assert-failed with the codes; passing ones advance", async () => {
  const recs = [];
  const base = (codes) => ({
    offReason: async () => null,
    last: async () => recs.at(-1) ?? { cycle: 1, phase: "assert", at: new Date().toISOString(), fingerprint: "f" },
    record: async (r) => { recs.push(r); },
    provisionOnce: async () => "done",
    inventory: async () => [],
    liveAsserts: async () => codes,
    purge: async () => "done",
    fingerprint: "f",
    now: () => new Date(),
  });
  const t = await probeStep(base(["default-branch-not-main"]));
  assert.equal(recs.at(-1).phase, "purge");
  assert.equal(recs.at(-1).result.code, "live-assert-failed");
  assert.equal(recs.at(-1).result.detail, "default-branch-not-main");
  assert.equal(t.exit, 3);
  recs.length = 0;
  await probeStep(base([]));
  assert.equal(recs.at(-1).phase, "purge");
  assert.equal(recs.at(-1).result, undefined);
});

test("d3c-2b pre-review 1: past the time budget no new read starts, and each check left is unreadable", async () => {
  const w = world();
  let t = 0;
  // The clock moves 10 units per call; the budget lets the first few checks start, then none.
  const out = await probeLiveAsserts({ mod: w.mod, gh: "GH", cf: "CF", projectId: PID, steps: async () => steps(), budgetMs: 25, now: () => (t += 10) });
  assert.ok(out.length > 0);
  for (const c of out) assert.match(c, /-unreadable(:|$)/);
  const before = w.reads.length;
  assert.ok(before < 9, `reads ${before}`);
  // A budget of 0 reads nothing at a provider.
  const w2 = world();
  const none = await probeLiveAsserts({ mod: w2.mod, gh: "GH", cf: "CF", projectId: PID, steps: async () => steps(), budgetMs: 0 });
  assert.deepEqual(w2.reads, []);
  assert.deepEqual(none, ["app-unreadable:preview", "app-unreadable:production", "default-branch-unreadable", "env-unreadable:preview", "more-1"]);
});

test("d3c-2b pre-review 2: a throw from pinning or the journal read ends the cycle live-assert-failed:error and purges", async () => {
  for (const which of ["pin", "journal"]) {
    const w = world();
    if (which === "pin") w.mod.pinnedCoolify = async () => { throw new Error("vault read failed with a body"); };
    const recs = [];
    const deps = {
      offReason: async () => null,
      last: async () => recs.at(-1) ?? { cycle: 1, phase: "assert", at: new Date().toISOString(), fingerprint: "f" },
      record: async (r) => { recs.push(r); },
      provisionOnce: async () => "done",
      inventory: async () => [],
      liveAsserts: () => probeLiveAsserts({ mod: w.mod, gh: "GH", cf: "CF", projectId: PID, steps: async () => { if (which === "journal") throw new Error("db down"); return steps(); } }),
      purge: async () => "done",
      fingerprint: "f",
      now: () => new Date(),
    };
    await probeStep(deps);
    assert.equal(recs.at(-1).phase, "purge", which);
    assert.equal(recs.at(-1).result.code, "live-assert-failed");
    assert.equal(recs.at(-1).result.detail, "error");
  }
});

test("Codex PR167-r1: a Compose read that crosses the deadline starts no later GET (tree, blob)", async () => {
  const w = world();
  // The clock is the number of provider reads so far: the deadline falls right after the commit read of CoreRepo.
  const n = () => w.reads.length;
  let deadlineAt = null;
  const probe = probeLiveAsserts({
    mod: w.mod, gh: "GH", cf: "CF", projectId: PID, steps: async () => steps(),
    // reads: 1 repo, 2 app(preview), 3 commit; the deadline is 3 so the tree read (4th) must not start.
    budgetMs: 3, now: () => n(),
  });
  const out = await probe;
  deadlineAt = 3;
  assert.equal(w.reads.length, deadlineAt);
  assert.ok(w.reads[2].includes("/git/commits/"));
  assert.ok(!w.reads.some((r) => r.includes("/git/trees/") || r.includes("/git/blobs/")));
  assert.ok(out.includes("compose-unreadable:preview"));
  for (const c of out) assert.match(c, /-unreadable(:|$)|^more-\d+$/);
});
