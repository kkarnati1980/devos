// Entry point. Secrets are read by name from the environment (Coolify env / server vault), never logged.
import { createApp } from "./app.js";
import { KkSessionRegistry } from "./auth.js";
import { loadConfig, loadTls, startupErrorCode } from "./config.js";
import { stdoutSink } from "./http.js";
import { TailscaleWhoisResolver } from "./identity.js";
import { buildRuntime, type DbClient } from "./runtime.js";
import type { DeadLetterQueue } from "./dead-letters.js";
import { analystModelPass, buildAnalystEngine, type RunEngineModule } from "./analyst-adapter.js";
import { ANALYST_MAX_SECONDS } from "./analyst-runner.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // R3-a: read the certificate files before anything else starts, so a missing file stops start-up early.
  const tls = loadTls(process.env, config.secureCookies);
  const kkSessions = new KkSessionRegistry();
  const { grants, readiness, setup, notify, deadLetters, approvals, requirements, requirementsSync, analystSweep } = await buildRuntime(process.env, {
    outboundTimeoutMs: config.outboundTimeoutMs,
    kkSessions,
    loadDb: async (url) => {
      // @devos/db is a declared dependency of @devos/api (PR14-r1); it is imported at runtime so the
      // API typechecks without the generated Prisma client (CI runs prisma generate).
      const dbModuleName = "@devos/db";
      const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => DbClient };
      return createDb(url);
    },
    loadQueue: async (redisUrl) => {
      // DEVOS-77: M1.5's RunQueue, imported at runtime like @devos/db so the API typechecks on its own.
      const queueModuleName = "@devos/run-engine";
      const { RunQueue } = (await import(queueModuleName)) as { RunQueue: new (o: { redisUrl: string; opTimeoutMs?: number }) => DeadLetterQueue };
      const q = new RunQueue({ redisUrl, opTimeoutMs: config.outboundTimeoutMs }) as DeadLetterQueue & { queue: { on(ev: "error", fn: () => void): unknown } };
      // A Redis error is logged as a fixed code at most once a minute, never its message (behaviour 4).
      let lastLog = 0;
      q.queue.on("error", () => {
        const t = Date.now();
        if (t - lastLog < 60_000) return;
        lastLog = t;
        stdoutSink({ ts: new Date(t).toISOString(), level: "warn", msg: "dead-letters-queue-error" });
      });
      return q;
    },
    // M2.2-d3b2: the analyst model pass is opt-in (`DEVOS_ANALYST_MODEL_PASS=on`); off, intake stays deterministic.
    ...(analystModelPass(process.env)
      ? {
          loadAnalystEngine: async (db, policy, apiKey) => {
            const runEngineModuleName = "@devos/run-engine";
            const m = (await import(runEngineModuleName)) as RunEngineModule;
            return buildAnalystEngine(m, db, policy, { apiKey, timeoutMs: ANALYST_MAX_SECONDS * 1000 });
          },
        }
      : {}),
  });

  const app = await createApp({
    config,
    identity: new TailscaleWhoisResolver(config.tailscaleSocket, config.outboundTimeoutMs),
    grants,
    readiness,
    kkSessions,
    setup,
    notify,
    deadLetters,
    approvals,
    requirements,
    tls,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  // M2.2-d3c1: decided requirements cards are applied without waiting for the sync POST; stopped with the process.
  requirementsSync?.start();
  // DEVOS-171: analyst runs the runner could not close (DB down) are closed and settled, at start-up and every 5 min.
  analystSweep?.start();
  process.once("SIGTERM", () => { requirementsSync?.stop(); analystSweep?.stop(); });
  process.once("SIGINT", () => { requirementsSync?.stop(); analystSweep?.stop(); });
  stdoutSink({ ts: new Date().toISOString(), level: "info", msg: "api-started", port: config.port, tls: tls !== null, policyEngine: grants !== null, vault: setup.vault !== null, notifications: notify.notifier !== null, deadLetters: deadLetters.queue !== null, approvals: approvals.approvals !== null, requirements: requirements.pipeline !== null, requirementsSync: requirementsSync !== null, analystModelPass: analystModelPass(process.env) && requirements.pipeline !== null, analystSweep: analystSweep !== null });
}

main().catch((e: unknown) => {
  // Print only a controlled code, never e.message or configuration values (PR14-r2).
  stdoutSink({ ts: new Date().toISOString(), level: "error", msg: "api-start-failed", code: startupErrorCode(e) });
  process.exit(1);
});
