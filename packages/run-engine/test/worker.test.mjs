// R1 AT4: the worker entry point (docs/modules/R1.md R1-c). Config errors give a code and never the value;
// an unconfigured provider fails non-retryable and its reservation is freed; no Redis or database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryPolicyStore, PolicyEngine } from "@devos/policy";
import { MemoryRunStore, RunEngine } from "../dist/index.js";
import { UnconfiguredAdapter, adapterFor, loadWorkerConfig, workerStartupCode } from "../dist/worker-main.js";

const WORKER = fileURLToPath(new URL("../dist/worker-main.js", import.meta.url));
const GOOD = { DATABASE_URL: "postgresql://devos@localhost/devos", REDIS_URL: "redis://localhost:6379", DEVOS_POLICY_HMAC_KEY: "k".repeat(32) };

test("AT4 config: each missing or bad setting stops with its own config code", () => {
  assert.equal(loadWorkerConfig(GOOD).concurrency, 1);
  const cases = [
    [{ DATABASE_URL: "" }, "config-database-url-required"],
    [{ REDIS_URL: "http://x" }, "config-redis-url-required"],
    [{ DEVOS_POLICY_HMAC_KEY: "short" }, "config-policy-hmac-key-too-short"],
    [{ DEVOS_WORKER_CONCURRENCY: "0" }, "config-worker-concurrency-invalid"],
    [{ DEVOS_WORKER_CONCURRENCY: "abc" }, "config-worker-concurrency-invalid"],
  ];
  for (const [patch, code] of cases) assert.throws(() => loadWorkerConfig({ ...GOOD, ...patch }), new RegExp(`^Error: ${code}$`));
});

test("AT4 start-up failure logs a code, never a value", () => {
  assert.equal(workerStartupCode(new Error("config-redis-url-required")), "config-redis-url-required");
  assert.equal(workerStartupCode(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 secret"), { code: "ECONNREFUSED" })), "startup-econnrefused");
  assert.equal(workerStartupCode(new Error(["postgresql://devos", "x".repeat(8) + "@db/devos is bad"].join(":"))), "startup-failed");

  const secret = "s3cr3t-value-that-must-not-print";
  const r = spawnSync(process.execPath, [WORKER], {
    env: { PATH: process.env.PATH, DATABASE_URL: `postgresql://devos:${secret}@localhost/devos`, REDIS_URL: "redis://localhost:6379", DEVOS_POLICY_HMAC_KEY: "short" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /"code":"config-policy-hmac-key-too-short"/);
  assert.ok(!out.includes(secret), "no configuration value is printed");
});

test("AT4 an unconfigured provider fails non-retryable and frees its reservation", async () => {
  const store = new MemoryRunStore();
  const pstore = new MemoryPolicyStore({ mode: "observe" });
  const policy = new PolicyEngine({ store: pstore, hmacKey: randomBytes(32) });
  const runId = `run-${randomBytes(4).toString("hex")}`;
  store.runs.set(runId, { id: runId, taskId: "task-1", projectId: "proj-1", role: "builder", model: "claude-sonnet", attempt: 1, status: "queued", maxTurns: 10, maxSeconds: 60, maxCostUsd: 1, turns: 0 });
  const engine = new RunEngine({ store, policy, adapterFor: adapterFor({}) });
  const out = await engine.execute({ runId, provider: "anthropic", prompt: "x", cwd: "." });
  assert.equal(out.status, "failed");
  assert.equal(out.retryable, false);
  assert.equal(store.costs.reduce((a, c) => a + c.usd, 0), 0, "nothing charged");
  assert.ok(pstore.reservations.length >= 1, "a reservation was taken before the run started");
  assert.equal(pstore.reservations.filter((r) => r.status === "reserved").length, 0, "no reservation left open");
});

test("AT4 the registry is used when a provider is configured", () => {
  const fake = { name: "codex-exec" };
  const pick = adapterFor({ openai: () => fake });
  assert.equal(pick("openai"), fake);
  assert.ok(pick("anthropic") instanceof UnconfiguredAdapter);
  assert.equal(new UnconfiguredAdapter("openai").name, "codex-exec");
});
