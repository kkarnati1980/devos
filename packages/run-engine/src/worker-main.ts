// DevOS worker entry point (R1-c, docs/modules/R1.md). Builds the M1.5 RunEngine over the M1.1 database
// and the M1.7 policy engine, and consumes the run queue on the server's Redis. Configuration comes from
// the environment by name; a bad value stops start-up with a `config-*` code, never the value (PR14-r2).
import { fileURLToPath } from "node:url";
import { PolicyEngine, PrismaPolicyStore, type PrismaLike as PolicyPrismaLike, type Provider, type CapabilityEnvelope } from "@devos/policy";
import { RunEngine, type PolicyLike } from "./engine.js";
import { PrismaRunStore, type PrismaLike } from "./prisma-store.js";
import { RunQueue } from "./queue.js";
import { RunFailure, type AdapterEvent, type RunAdapter, type RunResult, type RunTask } from "./types.js";

export const MIN_HMAC_KEY_BYTES = 32;

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

type Db = PrismaLike & PolicyPrismaLike & { $disconnect(): Promise<void> };

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ stop: () => Promise<void> }> {
  const cfg = loadWorkerConfig(env);
  // @devos/db is imported at run time so this package typechecks without the generated Prisma client.
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (url: string) => Db };
  const db = createDb(cfg.databaseUrl);
  const policy = new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: cfg.hmacKey }) as unknown as PolicyLike;
  const engine = new RunEngine({ store: new PrismaRunStore(db), policy, adapterFor: adapterFor({}) });
  const queue = new RunQueue({ redisUrl: cfg.redisUrl, concurrency: cfg.concurrency });
  queue.start(engine);
  log("info", "worker-started", { concurrency: cfg.concurrency });

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      // BullMQ's close waits for the active job; the engine checkpoints as it goes (M1.5), so a job cut
      // short by the grace period resumes from its checkpoint on the next start.
      await queue.close().catch(() => undefined);
      await db.$disconnect().catch(() => undefined);
      log("info", "worker-stopped");
    })());
  return { stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    ({ stop }) => {
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void stop().then(() => process.exit(0)));
    },
    (e: unknown) => {
      log("error", "worker-start-failed", { code: workerStartupCode(e) });
      process.exit(1);
    },
  );
}
