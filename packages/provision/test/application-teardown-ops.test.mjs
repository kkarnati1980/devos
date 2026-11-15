// M2.5-a3b (DEVOS-133, docs/modules/M2.5.md "M2.5-a3b decisions"): Coolify application teardown ops and the
// application half of the Coolify leftover scan, on a stub transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coolifyApplicationOps, coolifyScanner, ownershipMarker, ProviderError } from "../dist/index.js";

const PID = "11111111-2222-4333-8444-555555555555";
const UUID = "app-uuid-1";
const ITEM = { provider: "coolify", kind: "application", externalId: UUID, name: "devos-acme-preview" };

function stub(routes) {
  const calls = [];
  const http = {
    async get(path) { calls.push(["GET", path]); const r = routes[`GET ${path}`]; if (r instanceof Error) throw r; return r ?? { status: 404, body: null }; },
    async write(method, path) { calls.push([method, path]); const r = routes[`${method} ${path.split("?")[0]}`]; if (r instanceof Error) throw r; return r ?? { status: 200, body: {} }; },
  };
  return { cf: { http }, calls };
}

test("inspect: 404 is gone; a 200 for this uuid is owned only with the project's marker", async () => {
  const ops = coolifyApplicationOps(stub({}).cf, PID);
  assert.equal(await ops.inspect(ITEM), null);
  const mine = coolifyApplicationOps(stub({ [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: `x ${ownershipMarker(PID)}` } } }).cf, PID);
  assert.deepEqual(await mine.inspect(ITEM), { owned: true });
  const other = coolifyApplicationOps(stub({ [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: null } } }).cf, PID);
  assert.deepEqual(await other.inspect(ITEM), { owned: false });
});

test("inspect: anything but a 404 or a well-formed 200 for this uuid is inconclusive", async () => {
  for (const r of [
    { status: 500, body: null },
    { status: 200, body: null },
    { status: 200, body: { uuid: "another", description: "" } },
    { status: 200, body: { uuid: UUID, description: 42 } },
  ]) {
    const ops = coolifyApplicationOps(stub({ [`GET /api/v1/applications/${UUID}`]: r }).cf, PID);
    await assert.rejects(ops.inspect(ITEM), (e) => e instanceof ProviderError && e.code === "bad-response", JSON.stringify(r));
  }
});

test("archive stops the app (one call); there is no un-archive", async () => {
  const s = stub({ [`GET /api/v1/applications/${UUID}/stop`]: { status: 200, body: { message: "Stopping request queued." } } });
  const ops = coolifyApplicationOps(s.cf, PID);
  await ops.archive(ITEM);
  assert.deepEqual(s.calls, [["GET", `/api/v1/applications/${UUID}/stop`]]);
  assert.equal(ops.unarchive, undefined);
  const bad = coolifyApplicationOps(stub({ [`GET /api/v1/applications/${UUID}/stop`]: { status: 500, body: null } }).cf, PID);
  await assert.rejects(bad.archive(ITEM), ProviderError);
});

test("remove is one DELETE with volumes, configuration and networks; 404/410 is already gone; other errors throw", async () => {
  const s = stub({});
  await coolifyApplicationOps(s.cf, PID).remove(ITEM);
  assert.deepEqual(s.calls.map(([m]) => m), ["DELETE", "GET"], "one delete, then a read that confirms it is gone");
  const [method, path] = s.calls[0];
  assert.equal(method, "DELETE");
  const u = new URL(path, "http://x");
  assert.equal(u.pathname, `/api/v1/applications/${UUID}`);
  for (const k of ["delete_volumes", "delete_configurations", "docker_cleanup", "delete_connected_networks"]) assert.equal(u.searchParams.get(k), "true", k);
  for (const status of [404, 410]) {
    const g = stub({ [`DELETE /api/v1/applications/${UUID}`]: new ProviderError("coolify", "http", "gone", status) });
    await coolifyApplicationOps(g.cf, PID).remove(ITEM);
  }
  const f = stub({ [`DELETE /api/v1/applications/${UUID}`]: new ProviderError("coolify", "http", "forbidden", 403) });
  await assert.rejects(coolifyApplicationOps(f.cf, PID).remove(ITEM), (e) => e.status === 403);
});

test("an external id that is not a uuid is refused before any call", async () => {
  const s = stub({});
  const ops = coolifyApplicationOps(s.cf, PID);
  const bad = { ...ITEM, externalId: "../projects/x" };
  await assert.rejects(ops.inspect(bad), /coolify-uuid-invalid/);
  await assert.rejects(ops.remove(bad), /coolify-uuid-invalid/);
  await assert.rejects(ops.archive(bad), /coolify-uuid-invalid/);
  assert.equal(s.calls.length, 0);
});

test("the Coolify leftover scan finds the project's applications by name or marker, independent of the inventory", async () => {
  const s = stub({
    "GET /api/v1/projects": { status: 200, body: [] },
    "GET /api/v1/applications": { status: 200, body: [
      { uuid: "a-1", name: "devos-acme-preview", description: null },
      { uuid: "a-2", name: "renamed", description: `keep ${ownershipMarker(PID)}` },
      { uuid: "a-3", name: "devos-acme-live", description: "" },
      { uuid: "a-4", name: "devos-other-preview", description: "" },
    ] },
  });
  const hits = await coolifyScanner(s.cf).scan({ id: PID, slug: "acme" });
  assert.deepEqual(hits.map((h) => [h.kind, h.externalId]).sort(), [["application", "a-1"], ["application", "a-2"], ["application", "a-3"]]);
  const bad = stub({ "GET /api/v1/projects": { status: 200, body: [] }, "GET /api/v1/applications": { status: 502, body: null } });
  await assert.rejects(coolifyScanner(bad.cf).scan({ id: PID, slug: "acme" }), ProviderError, "an unreadable application list is never a clean scan");
});

test("pre-review 1: remove waits for a queued delete to show as gone, and gives up with a transient error", async () => {
  let reads = 0;
  const present = { status: 200, body: { uuid: UUID, description: "" } };
  const s = stub({});
  s.cf.http.get = async (path) => { s.calls.push(["GET", path]); return ++reads < 3 ? present : { status: 404, body: null }; };
  let t = 0;
  const opts = { sleep: async (ms) => { t += ms; }, now: () => t, pollMs: 2000, confirmMs: 60000 };
  await coolifyApplicationOps(s.cf, PID, opts).remove(ITEM);
  assert.equal(reads, 3, "read until the 404");
  assert.equal(s.calls.filter(([m]) => m === "DELETE").length, 1, "one delete");

  const stuck = stub({ [`GET /api/v1/applications/${UUID}`]: present });
  t = 0;
  await assert.rejects(coolifyApplicationOps(stuck.cf, PID, opts).remove(ITEM), (e) => e instanceof ProviderError && e.transient === true);
  assert.equal(stuck.calls.filter(([m]) => m === "DELETE").length, 1, "never a second delete");
  assert.ok(t >= 60000 && t < 64000, `bounded wait (${t} ms)`);
});

test("pre-review 3: a stop answering 404 for an app that is gone is nothing to stop; one that still exists fails", async () => {
  const gone = stub({ [`GET /api/v1/applications/${UUID}/stop`]: { status: 404, body: null } });
  await coolifyApplicationOps(gone.cf, PID).archive(ITEM);
  const odd = stub({
    [`GET /api/v1/applications/${UUID}/stop`]: { status: 404, body: null },
    [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "" } },
  });
  await assert.rejects(coolifyApplicationOps(odd.cf, PID).archive(ITEM), ProviderError);
});
