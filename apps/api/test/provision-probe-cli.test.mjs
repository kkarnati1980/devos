// DEVOS-234 (M2.4-d3c part 1): fingerprint and inventory read for the AT13 probe CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFingerprint, readProbeInventory } from "../dist/provision-probe-cli-parts.js";

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "probe-fp-"));
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), body);
  }
  return root;
}

test("d3c: the fingerprint changes with provisioning code only, not with other API files", async () => {
  const base = {
    "packages/provision/dist/index.js": "a",
    "packages/isolation/dist/compose.js": "b",
    "apps/api/dist/provision-runtime.js": "c",
    "apps/api/dist/routes.js": "d",
  };
  const r1 = await tree(base);
  const r2 = await tree({ ...base, "apps/api/dist/routes.js": "changed" });
  const r3 = await tree({ ...base, "packages/isolation/dist/compose.js": "changed" });
  const r4 = await tree({ ...base, "apps/api/dist/provision-runtime.js": "changed" });
  try {
    const f1 = await probeFingerprint(r1);
    assert.match(f1, /^[0-9a-f]{64}$/);
    assert.equal(await probeFingerprint(r2), f1, "an unrelated API file does not count");
    assert.notEqual(await probeFingerprint(r3), f1);
    assert.notEqual(await probeFingerprint(r4), f1);
  } finally {
    for (const r of [r1, r2, r3, r4]) await rm(r, { recursive: true, force: true });
  }
});

test("d3c: moving content between files changes the fingerprint; no files at all is an error", async () => {
  const a = await tree({ "packages/provision/dist/a.js": "xy", "packages/provision/dist/b.js": "" });
  const b = await tree({ "packages/provision/dist/a.js": "x", "packages/provision/dist/b.js": "y" });
  const empty = await tree({ "README.md": "x" });
  try {
    assert.notEqual(await probeFingerprint(a), await probeFingerprint(b));
    await assert.rejects(probeFingerprint(empty), /probe-fingerprint-empty/);
  } finally {
    for (const r of [a, b, empty]) await rm(r, { recursive: true, force: true });
  }
});

test("d3c: the inventory joins done steps to active resources; a lost row stays visible with an empty name", async () => {
  const seen = [];
  const db = {
    provisionStep: { findMany: async (q) => { seen.push(q.where); return [
      { key: "coolify_project", provider: "coolify", kind: "project", externalId: "p-1" },
      { key: "github_repo", provider: "github", kind: "repo", externalId: "42" },
      { key: "stack_preview", provider: "coolify", kind: "environment", externalId: null },
    ]; } },
    resource: { findMany: async (q) => { seen.push(q.where); return [
      { provider: "coolify", kind: "project", externalId: "p-1", name: "devos-probe-m24" },
      { provider: "github", kind: "repo", externalId: "42", name: "kkarnati1980/devos-probe-m24" },
      { provider: "github", kind: "repo", externalId: "99", name: "other" },
    ]; } },
  };
  const rows = await readProbeInventory(db, "proj-1");
  assert.deepEqual(rows, [
    { key: "coolify_project", provider: "coolify", externalId: "p-1", name: "devos-probe-m24" },
    { key: "github_repo", provider: "github", externalId: "42", name: "kkarnati1980/devos-probe-m24" },
    { key: "stack_preview", provider: "coolify", externalId: "", name: "" },
  ]);
  assert.deepEqual(seen, [{ projectId: "proj-1", status: "done" }, { projectId: "proj-1", status: "active" }]);
});
