// M2.4-d3b (DEVOS-228, docs/modules/M2.4.md "M2.4-d3b decisions"): S4's real isolationHook on the real S3 core.
// Carried from the c2a pre-review and d1: the deploy Compose is generated from the core's own compose.yaml (made by
// scripts/template/apply.mjs, no selection), hardened by the built @devos/isolation hook, and published on the
// tailnet port, with both built packages in one test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isolationHook, DEFAULT_LIMITS } from "@devos/isolation";
import { generateDeployCompose, parseCompose, assertPublished, DEPLOY_COMPOSE_HEADER, COMPOSE_PATH } from "../dist/index.js";

const ROOT = new URL("../../../", import.meta.url);
const { apply } = await import(new URL("scripts/template/apply.mjs", ROOT).href);

function coreCompose() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "d3b-core-")), "app");
  const r = apply({ out, select: [], sha: "c".repeat(40) });
  assert.equal(r.code, 0, r.error);
  const bytes = fs.readFileSync(path.join(out, COMPOSE_PATH));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return bytes;
}

// A CoreRepo stand-in: the core commit holds the generated compose.yaml, as github/core pushes it.
const repoWith = (bytes) => ({
  treeOf: async (commit) => { assert.equal(commit, "core-commit"); return new Map([[COMPOSE_PATH, { sha: "blob-compose" }]]); },
  blobContent: async (sha) => { assert.equal(sha, "blob-compose"); return bytes; },
});

const opts = (records) => ({
  owner: "devos-apps", serverUuid: "srv", tailnetIp: "100.64.0.7", range: { from: 20000, to: 20999 },
  hooks: { afterStack: isolationHook({ store: { recordStack: async (r) => { records.push(r); } } }) },
});

test("d3b: S4's real isolationHook hardens the real core compose.yaml for preview and live, then the port is published", async () => {
  const bytes = coreCompose();
  const original = parseCompose(bytes);
  assert.ok(original.services?.app, "the core has an app service");
  const records = [];
  const project = { id: "p-1", slug: "shop" };
  for (const [env, port, hookEnv] of [["preview", 20002, "preview"], ["production", 20003, "live"]]) {
    const out = await generateDeployCompose(repoWith(bytes), project, env, "core-commit", port, opts(records));
    const text = out.toString("utf8");
    assert.ok(text.startsWith(DEPLOY_COMPOSE_HEADER), env);
    const doc = parse(text.slice(DEPLOY_COMPOSE_HEADER.length));
    assertPublished(doc, port, "100.64.0.7");
    const app = doc.services.app;
    // S4's limits are on every service, and the stack sits on its own network.
    for (const [name, svc] of Object.entries(doc.services)) {
      // The core declares its own limits; S4 keeps them when they are within its caps (S4).
      assert.ok(Number(svc.cpus) > 0 && Number(svc.cpus) <= DEFAULT_LIMITS.caps.cpus, `${env} ${name} cpus ${svc.cpus}`);
      assert.ok(svc.pids_limit > 0, `${env} ${name} pids_limit`);
      assert.ok(svc.mem_limit !== undefined, `${env} ${name} mem_limit`);
      assert.notEqual(svc.privileged, true);
    }
    const net = `devos-p-shop-${hookEnv}`;
    assert.ok(doc.networks && Object.hasOwn(doc.networks, net), `${env}: network ${net}`);
    assert.ok(JSON.stringify(app.networks).includes(net), `${env}: app joins ${net}`);
  }
  assert.deepEqual(records.map((r) => [r.projectId, r.env, r.idx, r.network]), [
    ["p-1", "preview", 2, "devos-p-shop-preview"],
    ["p-1", "live", 3, "devos-p-shop-live"],
  ]);
});

test("d3b: the real hook refuses an unsafe change to the core compose, and nothing is recorded", async () => {
  const records = [];
  const unsafe = Buffer.from(coreCompose().toString("utf8").replace(/^services:\n/m, "services:\n  sidecar:\n    image: busybox\n    privileged: true\n"));
  assert.ok(parseCompose(unsafe).services.sidecar.privileged);
  await assert.rejects(generateDeployCompose(repoWith(unsafe), { id: "p-2", slug: "shop" }, "preview", "core-commit", 20004, opts(records)),
    (e) => e.code === "compose_unsafe");
  assert.deepEqual(records, []);
});
