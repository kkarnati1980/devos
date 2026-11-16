// M2.6-b2b3 (DEVOS-248): the "Open in Linear" links are read by stored id, kept only on https://linear.app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linearLinks, linearUrl, LINK_MAX_ISSUES } from "../dist/index.js";

const P = "11111111-1111-4111-8111-111111111111";
const I1 = "22222222-2222-4222-8222-222222222222";
const I2 = "33333333-3333-4333-8333-333333333333";

function reader(answer) {
  const calls = [];
  return { calls, async query(q, v) { calls.push({ q, v }); return answer(q, v); } };
}

test("linearUrl keeps only https URLs on linear.app", () => {
  assert.equal(linearUrl("https://linear.app/ws/project/x-abc"), "https://linear.app/ws/project/x-abc");
  for (const bad of ["http://linear.app/ws", "https://evil.example/ws", "https://linear.app.evil.example/x", "javascript:alert(1)",
    "https://u:p@linear.app/x", "https://linear.app:8443/x", "", null, 42, "https://linear.app/" + "a".repeat(600)]) {
    assert.equal(linearUrl(bad), null, String(bad));
  }
});

test("reads the project and issues by stored id and returns only linear.app URLs", async () => {
  const r = reader((q) => q.includes("projects(")
    ? { projects: { nodes: [{ id: P, url: "https://linear.app/ws/project/demo-1a2b" }] } }
    : { issues: { nodes: [{ id: I1, url: "https://linear.app/ws/issue/DEVOS-1/x" }, { id: I2, url: "javascript:alert(1)" }, { id: "other", url: "https://linear.app/ws/issue/DEVOS-9" }] } });
  const out = await linearLinks(r, { projectId: P, issueIds: [I1, I2, I1] });
  assert.deepEqual(out, { project: "https://linear.app/ws/project/demo-1a2b", issues: { [I1]: "https://linear.app/ws/issue/DEVOS-1/x" } });
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1].v, { ids: [I1, I2] }, "ids deduplicated");
  assert.match(r.calls[0].q, /^query/, "a read, never a mutation");
  assert.match(r.calls[1].q, /^query/);
});

test("no stored ids → no Linear call and no links; non-UUID ids are never sent", async () => {
  const r = reader(() => { throw new Error("must not be called"); });
  assert.deepEqual(await linearLinks(r, { projectId: null, issueIds: [] }), { project: null, issues: {} });
  assert.deepEqual(await linearLinks(r, { projectId: "x\" } }", issueIds: ["DEVOS-1", "../a"] }), { project: null, issues: {} });
  assert.equal(r.calls.length, 0);
});

test("an unknown project is absent, issues are capped, a Linear failure throws", async () => {
  const many = Array.from({ length: LINK_MAX_ISSUES + 5 }, (_, k) => `44444444-4444-4444-8444-${String(k).padStart(12, "0")}`);
  const r = reader((q) => (q.includes("projects(") ? { projects: { nodes: [] } } : { issues: { nodes: [] } }));
  assert.deepEqual(await linearLinks(r, { projectId: P, issueIds: many }), { project: null, issues: {} });
  assert.equal(r.calls[1].v.ids.length, LINK_MAX_ISSUES);
  const failing = reader(() => { throw new Error("Linear down"); });
  await assert.rejects(linearLinks(failing, { projectId: P, issueIds: [] }), /Linear down/);
});
