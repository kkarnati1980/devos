// DevOS worker entry point (R1-c, docs/modules/R1.md). Builds the M1.5 RunEngine over the M1.1 database
// and the M1.7 policy engine, and consumes the run queue on the server's Redis. Configuration comes from
// the environment by name; a bad value stops start-up with a `config-*` code, never the value (PR14-r2).
import { fileURLToPath } from "node:url";
import { PolicyEngine, PrismaPolicyStore, type PrismaLike as PolicyPrismaLike, type Provider, type CapabilityEnvelope } from "@devos/policy";
import { RunEngine, type PolicyLike } from "./engine.js";
import { PrismaRunStore, type PrismaLike } from "./prisma-store.js";
import { RunQueue } from "./queue.js";
import { ProbeGateAdapter } from "./probe-adapter.js";
import { RunFailure, type AdapterEvent, type RunAdapter, type RunResult, type RunTask } from "./types.js";

export const MIN_HMAC_KEY_BYTES = 32;
/**
 * PR20-r1: how long a graceful stop waits for the active job (ms). The worker's RunQueue only starts and
 * closes, so its per-operation deadline is this drain budget. It stays under compose's
 * `stop_grace_period: 60s`, so the drain ends before Docker sends SIGKILL.
 */
export const DRAIN_TIMEOUT_MS = 50_000;
/**
 * R2: a worker killed without a drain (OOM, host restart, the G1 `run-resume` check) leaves its job
 * active until the BullMQ lock expires; a stalled check then moves it back and the run resumes from its
 * checkpoint. 15 s / 5 s bounds that to about 20 s (BullMQ's 30 s / 30 s took up to ~90 s in CI).
 */
export const LOCK_DURATION_MS = 15_000;
export const STALLED_INTERVAL_MS = 5_000;

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  hmacKey: Buffer;
  concurrency: number;
}

/** Parse and validate the worker environment. Throws a `config-*` code (never the value). */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error("config-database-url-required");
  const redisUrl = env.REDIS_URL ?? "";
  if (!/^rediss?:\/\//.test(redisUrl)) throw new Error("config-redis-url-required");
  const hmacKey = Buffer.from(env.DEVOS_POLICY_HMAC_KEY ?? "", "utf8");
  if (hmacKey.length < MIN_HMAC_KEY_BYTES) throw new Error("config-policy-hmac-key-too-short");
  const concurrency = Number(env.DEVOS_WORKER_CONCURRENCY ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("config-worker-concurrency-invalid");
  return { databaseUrl, redisUrl, hmacKey, concurrency };
}

const CONFIG_CODE = /^config-[a-z0-9-]+$/;
const NODE_ERROR_CODE = /^E[A-Z0-9_]{1,40}$/;

/** Map a start-up failure to a controlled code; dependency messages are never logged. */
export function workerStartupCode(e: unknown): string {
  if (e instanceof Error) {
    if (CONFIG_CODE.test(e.message)) return e.message;
    const sys = (e as { code?: unknown }).code;
    if (typeof sys === "string" && NODE_ERROR_CODE.test(sys)) return `startup-${sys.toLowerCase()}`;
  }
  return "startup-failed";
}

/**
 * A provider whose runtime is not installed in this image (M3.x wires the Claude Agent SDK and Codex).
 * Its run fails non-retryable with `provider-unconfigured`; nothing is skipped silently.
 */
export class UnconfiguredAdapter implements RunAdapter {
  readonly name: RunAdapter["name"];
  constructor(readonly provider: Provider) {
    this.name = provider === "openai" ? "codex-exec" : "claude-agent-sdk";
  }
  async start(_task: RunTask, _envelope: CapabilityEnvelope | null): Promise<void> {
    throw new RunFailure("internal", "provider-unconfigured", false);
  }
  async *events(): AsyncIterable<AdapterEvent> {
    // never started: no events
  }
  async cancel(_runId: string): Promise<void> {}
  async result(): Promise<RunResult> {
    throw new RunFailure("internal", "provider-unconfigured", false);
  }
}

export type AdapterRegistry = Partial<Record<Provider, () => RunAdapter>>;

/** A fresh adapter per run; providers missing from the registry get the UnconfiguredAdapter. */
export function adapterFor(registry: AdapterRegistry): (provider: Provider) => RunAdapter {
  return (provider) => registry[provider]?.() ?? new UnconfiguredAdapter(provider);
}

/**
 * R2-b: every provider's adapter is wrapped so a run whose model is PROBE_MODEL (the G1 `run-resume`
 * check's own run) gets the in-image probe; every other run keeps the registry's adapter.
 */
export function probeGated(registry: AdapterRegistry): (provider: Provider) => RunAdapter {
  const normal = adapterFor(registry);
  return (provider) => new ProbeGateAdapter(provider, () => normal(provider));
}

type Db = PrismaLike & PolicyPrismaLike & { $disconnect(): Promise<void> };

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ stop: () => Promise<boolean> }> {
  const cfg = loadWorkerConfig(env);
  // @devos/db is imported at run time so this package typechecks without the generated Prisma client.
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (url: string) => Db };
  const db = createDb(cfg.databaseUrl);
  const policy = new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: cfg.hmacKey }) as unknown as PolicyLike;
  const engine = new RunEngine({ store: new PrismaRunStore(db), policy, adapterFor: probeGated({}) });
  const queue = new RunQueue({ redisUrl: cfg.redisUrl, concurrency: cfg.concurrency, opTimeoutMs: DRAIN_TIMEOUT_MS, lockDurationMs: LOCK_DURATION_MS, stalledIntervalMs: STALLED_INTERVAL_MS });
  queue.start(engine);
  log("info", "worker-started", { concurrency: cfg.concurrency });

  let stopping: Promise<boolean> | null = null;
  /** Graceful stop. true = the active job settled; false = the drain timed out or failed (exit non-zero). */
  const stop = () =>
    (stopping ??= drain(queue, db));
  return { stop };
}

/**
 * PR20-r1: stop taking jobs and wait for the active one (BullMQ `Worker.close()`). A drain that times out
 * or fails is reported, never hidden: the caller exits 1, and the cut-short job resumes from its M1.5
 * checkpoint on the next start.
 */
export async function drain(queue: { close(): Promise<void> }, db: { $disconnect(): Promise<void> }): Promise<boolean> {
  let drained = true;
  try {
    await queue.close();
  } catch (e) {
    drained = false;
    log("error", "worker-drain-failed", { code: e instanceof Error && /^queue-[a-z-]+$/.test(e.message) ? e.message : "drain-failed" });
  }
  await db.$disconnect().catch(() => undefined);
  log("info", "worker-stopped", { drained });
  return drained;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    ({ stop }) => {
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void stop().then((drained) => process.exit(drained ? 0 : 1)));
    },
    (e: unknown) => {
      log("error", "worker-start-failed", { code: workerStartupCode(e) });
      process.exit(1);
    },
  );
}
