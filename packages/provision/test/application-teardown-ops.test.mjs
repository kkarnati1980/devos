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

test("archive stops the app (one call, then a read that shows it stopped); there is no un-archive", async () => {
  const s = stub({
    [`POST /api/v1/applications/${UUID}/stop`]: { status: 200, body: { message: "Stopping request queued." } },
    [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "", status: "exited:unhealthy" } },
  });
  const ops = coolifyApplicationOps(s.cf, PID);
  await ops.archive(ITEM);
  assert.deepEqual(s.calls, [["POST", `/api/v1/applications/${UUID}/stop?docker_cleanup=false`], ["GET", `/api/v1/applications/${UUID}`]]);
  assert.equal(ops.unarchive, undefined);
  const bad = coolifyApplicationOps(stub({ [`POST /api/v1/applications/${UUID}/stop`]: new ProviderError("coolify", "http", "coolify POST /api/v1/applications/{uuid}/stop returned 500", 500) }).cf, PID);
  await assert.rejects(bad.archive(ITEM), (e) => e instanceof ProviderError && e.code === "http" && e.status === 500);
});

test("AT13 fix, part 10: the stop is a POST (Coolify 4.5 answers a GET with 405), never a GET", async () => {
  const s = stub({ [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "", status: "exited" } } });
  await coolifyApplicationOps(s.cf, PID).archive(ITEM);
  assert.ok(!s.calls.some(([m, p]) => m === "GET" && p.endsWith("/stop")), "no GET of the stop route");
  assert.equal(s.calls.filter(([m, p]) => m === "POST" && p === `/api/v1/applications/${UUID}/stop?docker_cleanup=false`).length, 1, "exactly one stop write, with docker_cleanup=false (Codex PR234-r3)");
});

test("Codex PR154-r3: a queued stop that still shows running when the bound ends fails; a missing status is inconclusive", async () => {
  let t = 0;
  const o = { sleep: async (ms) => { t += ms; }, now: () => t, confirmMs: 6000, pollMs: 2000 };
  const stop = { [`POST /api/v1/applications/${UUID}/stop`]: { status: 200, body: { message: "Stopping request queued." } } };
  const running = stub({ ...stop, [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "", status: "running:healthy" } } });
  await assert.rejects(coolifyApplicationOps(running.cf, PID, o).archive(ITEM), (e) => e instanceof ProviderError && e.code === "timeout");
  assert.equal(running.calls.filter(([, p]) => p === `/api/v1/applications/${UUID}`).length, 4, "bounded: reads at 0, 2, 4 and 6 s");
  for (const status of [undefined, 7, null]) {
    const s = stub({ ...stop, [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "", status } } });
    await assert.rejects(coolifyApplicationOps(s.cf, PID, o).archive(ITEM), (e) => e instanceof ProviderError && e.code === "bad-response");
  }
  for (const status of ["exited", "stopped", "exited:unhealthy"]) {
    const s = stub({ ...stop, [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "", status } } });
    await coolifyApplicationOps(s.cf, PID, o).archive(ITEM);
  }
  const gone = stub(stop); // stopped, then deleted by hand before the read: nothing left running
  await coolifyApplicationOps(gone.cf, PID, o).archive(ITEM);
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

test("Codex PR154-r1: an application without a description field makes the scan inconclusive, never clean", async () => {
  for (const app of [{ uuid: "app-stray-1", name: "renamed" }, { uuid: "app-stray-2", name: "renamed", description: 7 }]) {
    const s = stub({ "GET /api/v1/projects": { status: 200, body: [] }, "GET /api/v1/applications": { status: 200, body: [app] } });
    await assert.rejects(coolifyScanner(s.cf).scan({ id: PID, slug: "acme" }), (e) => e instanceof ProviderError && e.code === "bad-response", JSON.stringify(app));
  }
  const ok = stub({ "GET /api/v1/projects": { status: 200, body: [] }, "GET /api/v1/applications": { status: 200, body: [{ uuid: "a-9", name: "unrelated", description: null }] } });
  assert.deepEqual(await coolifyScanner(ok.cf).scan({ id: PID, slug: "acme" }), [], "null is an explicit empty description");
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
  const gone = stub({ [`POST /api/v1/applications/${UUID}/stop`]: new ProviderError("coolify", "http", "coolify POST /api/v1/applications/{uuid}/stop returned 404", 404) });
  await coolifyApplicationOps(gone.cf, PID).archive(ITEM);
  const odd = stub({
    [`POST /api/v1/applications/${UUID}/stop`]: new ProviderError("coolify", "http", "coolify POST /api/v1/applications/{uuid}/stop returned 404", 404),
    [`GET /api/v1/applications/${UUID}`]: { status: 200, body: { uuid: UUID, description: "" } },
  });
  await assert.rejects(coolifyApplicationOps(odd.cf, PID).archive(ITEM), ProviderError);
});
