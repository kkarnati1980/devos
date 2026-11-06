// M1.5 queue against a real Redis (BullMQ): non-retryable errors are never retried, retryable ones
// back off and retry, and a job that fails for good is listed in the dead-letter view and retried.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RunQueue } from "../dist/index.js";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for test:db");
const queues = [];
after(async () => {
  for (const q of queues) await q.close();
});

/** A stand-in engine: outcomes per call, recording how often each run was executed. */
function engine(outcomes) {
  const calls = new Map();
  return {
    calls,
    async execute(input) {
      const n = (calls.get(input.runId) ?? 0) + 1;
      calls.set(input.runId, n);
      const o = outcomes(input.runId, n);
      if (o instanceof Error) throw o;
      return { runId: input.runId, costUsd: 0, costEstimated: false, turns: 1, lastSeq: 2, countsAsAttempt: false, retryable: false, ...o };
    },
  };
}

async function until(fn, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

test("Queue: a non-retryable error is never retried and lands in the dead-letter view; retry re-runs it", async () => {
  const q = new RunQueue({ redisUrl, name: `m15-${randomBytes(4).toString("hex")}`, attempts: 3, backoff: { baseMs: 10, maxMs: 20 } });
  queues.push(q);
  let poisoned = true;
  const e = engine(() => (poisoned ? { status: "failed", errorType: "missing_input", retryable: false, countsAsAttempt: true } : { status: "succeeded" }));
  q.start(e);
  await q.enqueue({ runId: "poison-1", provider: "anthropic", prompt: "x", cwd: "." });
  await until(async () => (await q.deadLetters()).length === 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(e.calls.get("poison-1"), 1, "never retried");
  const [dl] = await q.deadLetters();
  assert.equal(dl.runId, "poison-1");
  assert.match(dl.reason, /run-missing_input/);
  poisoned = false;
  assert.equal(await q.retryDead(dl.jobId), true);
  await until(async () => (await q.queue.getJobState(dl.jobId)) === "completed");
  assert.equal(e.calls.get("poison-1"), 2);
  assert.equal((await q.deadLetters()).length, 0);
});

test("Queue: a retryable error is retried with backoff until it succeeds", async () => {
  const q = new RunQueue({ redisUrl, name: `m15-${randomBytes(4).toString("hex")}`, attempts: 3, backoff: { baseMs: 10, maxMs: 20 } });
  queues.push(q);
  const e = engine((_, n) => (n < 3 ? { status: "failed", errorType: "rate_limited", retryable: true, countsAsAttempt: true } : { status: "succeeded" }));
  q.start(e);
  const id = await q.enqueue({ runId: "flaky-1", provider: "anthropic", prompt: "x", cwd: "." });
  await until(async () => (await q.queue.getJobState(id)) === "completed");
  assert.equal(e.calls.get("flaky-1"), 3);
});

test("Queue: a crash (thrown store error) is retried, so the next execute resumes from the checkpoint", async () => {
  const q = new RunQueue({ redisUrl, name: `m15-${randomBytes(4).toString("hex")}`, attempts: 2, backoff: { baseMs: 10, maxMs: 20 } });
  queues.push(q);
  const e = engine((_, n) => (n === 1 ? new Error("store-down") : { status: "succeeded" }));
  q.start(e);
  const id = await q.enqueue({ runId: "crash-1", provider: "anthropic", prompt: "x", cwd: "." });
  await until(async () => (await q.queue.getJobState(id)) === "completed");
  assert.equal(e.calls.get("crash-1"), 2);
});
