// SM-05 add-on tests. SM-05-L1: work over about 2 s runs from a queue; a poisoned job lands in the dead-letter
// queue and can be retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { createQueue, deadLetterRoutes, fileStore, memoryStore, JobTimeout } from "../src/queue.mjs";

const fast = { backoffMs: [0], timeoutMs: 1000 };

test("SM-05-L1: work runs from the queue once started; retries follow the policy", async () => {
  const seen = [];
  let flaky = 0;
  const events = [];
  const q = createQueue({
    ...fast, maxAttempts: 3, onEvent: (e) => events.push(e.event),
    handlers: {
      "report.build": async (p) => { seen.push(p.n); },
      "mail.send": async () => { flaky += 1; if (flaky < 3) throw new Error("smtp 421"); },
    },
  });
  q.enqueue("report.build", { n: 1 });
  q.enqueue("mail.send", {});
  assert.deepEqual(seen, [], "nothing runs before start");
  q.start();
  await q.idle();
  assert.deepEqual(seen, [1]);
  assert.equal(flaky, 3, "two failures, then success on the third attempt");
  assert.deepEqual(q.stats(), { queued: 0, running: 0, dead: 0 });
  assert.deepEqual(events.filter((e) => e === "job.retry").length, 2);
  assert.throws(() => q.enqueue("no.such.type", {}), /no handler/);
  q.stop();
});

test("SM-05-L1: a stored job with no own handler is dead-lettered at once; a throwing event callback changes nothing", async () => {
  const stored = [{ id: "33333333-3333-4333-8333-333333333333", type: "constructor", payload: {}, status: "queued", attempts: 0, runAfter: 0, enqueuedAt: "2026-11-14T00:00:00.000Z" }];
  const store = memoryStore(); store.save(stored);
  let ran = 0;
  const q = createQueue({ ...fast, maxAttempts: 3, store, onEvent: () => { throw new Error("callback bug"); }, handlers: { "a.b": async () => { ran += 1; } } });
  q.start();
  q.enqueue("a.b", {});
  await q.idle();
  assert.equal(ran, 1, "the throwing callback did not turn a success into a failure");
  const [d] = q.deadLetters();
  assert.equal(d.type, "constructor");
  assert.match(d.lastError, /no handler for "constructor"/);
  q.stop();
});

test("SM-05-L1: a poisoned job lands in the dead-letter list with its last error, and a retry runs it again", async () => {
  let fixed = false;
  const attempts = [];
  const q = createQueue({ ...fast, maxAttempts: 2, handlers: { "image.resize": async (p, { attempt }) => { attempts.push(attempt); if (!fixed) throw new Error(`bad input ${p.file}`); } } });
  q.start();
  const id = q.enqueue("image.resize", { file: "a.png" });
  await q.idle();
  assert.deepEqual(attempts, [1, 2]);
  const dead = q.deadLetters();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, id);
  assert.equal(dead[0].attempts, 2);
  assert.match(dead[0].lastError, /Error: bad input a\.png/);
  assert.ok(dead[0].deadAt);
  assert.ok(!("payload" in dead[0]), "the dead-letter view never shows the payload");
  // Retry: a fresh attempt count, and it succeeds once the cause is fixed.
  fixed = true;
  assert.equal(q.retryDead(id), true);
  await q.idle();
  assert.deepEqual(attempts, [1, 2, 1]);
  assert.deepEqual(q.deadLetters(), []);
  assert.equal(q.retryDead(id), false, "only a dead job can be retried");
  q.stop();
});

test("SM-05-L1: an attempt that hangs is aborted at the timeout and counted as failed", async () => {
  let aborted = 0;
  const q = createQueue({ backoffMs: [0], timeoutMs: 50, maxAttempts: 1, handlers: {
    "slow.task": (p, { signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted += 1; }); }),
  } });
  q.start();
  q.enqueue("slow.task", {});
  await q.idle();
  assert.equal(aborted, 1);
  const [d] = q.deadLetters();
  assert.match(d.lastError, /^JobTimeout: job attempt timed out after 50 ms/);
  assert.ok(new JobTimeout(1) instanceof Error);
  q.stop();
});

test("SM-05-L1: queued and dead jobs survive a restart through the file store; a job cut off by stop runs again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm05-"));
  try {
    const path = join(dir, "data", "jobs.json");
    let release;
    const q1 = createQueue({ ...fast, maxAttempts: 1, store: fileStore(path), handlers: {
      "bad.job": async () => { throw new Error("poison"); },
      "long.job": () => new Promise((r) => { release = r; }),
    } });
    q1.start();
    const deadId = q1.enqueue("bad.job", { k: 1 });
    await q1.idle();
    const longId = q1.enqueue("long.job", { k: 2 });
    assert.equal(q1.stats().running, 1);
    q1.stop(); // the long job was running: it is not a failure
    await new Promise((r) => setImmediate(r));
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(onDisk.map((j) => [j.id, j.status]).sort(), [[deadId, "dead"], [longId, "queued"]].sort());
    release?.();

    const ran = [];
    const q2 = createQueue({ ...fast, maxAttempts: 1, store: fileStore(path), handlers: {
      "bad.job": async (p) => { ran.push(["bad", p.k]); },
      "long.job": async (p) => { ran.push(["long", p.k]); },
    } });
    assert.deepEqual(q2.deadLetters().map((d) => d.id), [deadId], "the dead letter is still visible after the restart");
    q2.start();
    await q2.idle();
    assert.deepEqual(ran, [["long", 2]], "the cut-off job runs again; the dead one waits for a retry");
    assert.equal(q2.retryDead(deadId), true);
    await q2.idle();
    assert.deepEqual(ran, [["long", 2], ["bad", 1]]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
    q2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SM-05-L1: a job that was running when the process died keeps the attempt, so a crashing job reaches the dead-letter list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm05-"));
  try {
    const path = join(dir, "jobs.json");
    const crashed = { id: "11111111-1111-4111-8111-111111111111", type: "pdf.render", payload: {}, status: "running", attempts: 3, runAfter: 0, enqueuedAt: "2026-11-14T00:00:00.000Z" };
    const midway = { ...crashed, id: "22222222-2222-4222-8222-222222222222", attempts: 1 };
    fileStore(path).save([crashed, midway]);
    const attempts = [];
    const q = createQueue({ ...fast, maxAttempts: 3, store: fileStore(path), handlers: { "pdf.render": async (p, { attempt }) => { attempts.push(attempt); } } });
    const [dead] = q.deadLetters();
    assert.equal(dead.id, crashed.id, "no attempts left: dead-lettered at start-up instead of crashing every boot");
    assert.match(dead.lastError, /^interrupted/);
    q.start();
    await q.idle();
    assert.deepEqual(attempts, [2], "the other one runs again with its count kept");
    q.stop();
    // A list that is not a valid job list is refused rather than half-trusted.
    fileStore(path).save([{ id: "x", status: "weird" }]);
    assert.throws(() => fileStore(path).load(), /valid job list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SM-05-L1: a store that cannot write is reported, and the queue keeps working", async () => {
  const events = [];
  let ran = 0;
  const broken = { load: () => [], save: () => { throw new Error("ENOSPC: no space left on device"); } };
  const q = createQueue({ ...fast, store: broken, onEvent: (e) => events.push(e), handlers: { "a.b": async () => { ran += 1; } } });
  q.start();
  q.enqueue("a.b", {});
  q.enqueue("a.b", {});
  await q.idle();
  assert.equal(ran, 2);
  assert.ok(events.some((e) => e.event === "store.error" && /ENOSPC/.test(e.error)));
  assert.deepEqual(q.stats(), { queued: 0, running: 0, dead: 0 });
  q.stop();
  await q.idle(); // resolves once stopped
});

test("SM-05-L1: a large backlog of stored jobs with no handler is dead-lettered without exhausting the stack", async () => {
  const store = memoryStore();
  const n = 4000; // enough that a direct pump() per job would nest several thousand frames deep
  const hex = (i) => i.toString(16).padStart(12, "0");
  store.save(Array.from({ length: n }, (_, i) => ({ id: `44444444-4444-4444-8444-${hex(i)}`, type: "gone.type", payload: {}, status: "queued", attempts: 0, runAfter: 0, enqueuedAt: "2026-11-14T00:00:00.000Z" })));
  const q = createQueue({ ...fast, store, handlers: { "a.b": async () => {} } });
  q.start();
  await q.idle();
  assert.equal(q.stats().dead, n);
  q.stop();
});

test("SM-05-L1: the dead-letter routes list, retry and discard; bad ids are refused", async () => {
  const q = createQueue({ ...fast, maxAttempts: 1, store: memoryStore(), handlers: { "x.y": async () => { throw new Error("nope"); } } });
  q.start();
  const a = q.enqueue("x.y", {});
  const b = q.enqueue("x.y", {});
  await q.idle();
  q.stop(); // keep the retried job dead-lettered again only after we look
  const app = createApp({ config: loadConfig({ GIT_SHA: "abc1234" }), out: { write: () => {} }, routes: deadLetterRoutes(q) });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}/admin/dead-letters`;
  const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  try {
    let r = await fetch(base);
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.deepEqual(body.deadLetters.map((d) => d.id).sort(), [a, b].sort());
    assert.deepEqual(body.stats, { queued: 0, running: 0, dead: 2 });
    r = await post("/retry", JSON.stringify({ id: a }));
    assert.equal(r.status, 200);
    assert.equal(q.stats().queued, 1, "retried: queued again (the queue is stopped, so it waits)");
    r = await post("/discard", JSON.stringify({ id: b }));
    assert.equal(r.status, 200);
    assert.equal(q.stats().dead, 0);
    assert.equal((await post("/retry", JSON.stringify({ id: b }))).status, 404);
    for (const bad of ["{}", "not json", JSON.stringify({ id: "../../etc" }), JSON.stringify({ id: "x".repeat(2000) })]) {
      assert.equal((await post("/retry", bad)).status, 400, bad.slice(0, 20));
    }
  } finally {
    app.close();
  }
});

test("SM-05-L1: set-up is checked", () => {
  assert.throws(() => createQueue({}), /handlers is required/);
  assert.throws(() => createQueue({ handlers: { "Bad Type": async () => {} } }), /bad handler/);
  assert.throws(() => createQueue({ handlers: { "a.b": async () => {} }, maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createQueue({ handlers: { "a.b": async () => {} }, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => createQueue({ handlers: { "a.b": async () => {} }, backoffMs: [] }), /backoffMs/);
  assert.throws(() => fileStore(""), /path is required/);
});
