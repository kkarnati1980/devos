// Entry point. Secrets are read by name from the environment (Coolify env / server vault), never logged.
import { createApp } from "./app.js";
import { KkSessionRegistry } from "./auth.js";
import { loadConfig } from "./config.js";
import { stdoutSink } from "./http.js";
import { TailscaleWhoisResolver } from "./identity.js";
import { buildRuntime, type DbClient } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const kkSessions = new KkSessionRegistry();
  const { grants, readiness } = await buildRuntime(process.env, {
    outboundTimeoutMs: config.outboundTimeoutMs,
    kkSessions,
    loadDb: async (url) => {
      // @devos/db is a declared dependency of @devos/api (PR14-r1); it is imported at runtime so the
      // API typechecks without the generated Prisma client (CI runs prisma generate).
      const dbModuleName = "@devos/db";
      const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => DbClient };
      return createDb(url);
    },
  });

  const app = await createApp({
    config,
    identity: new TailscaleWhoisResolver(config.tailscaleSocket, config.outboundTimeoutMs),
    grants,
    readiness,
    kkSessions,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  stdoutSink({ ts: new Date().toISOString(), level: "info", msg: "api-started", port: config.port, policyEngine: grants !== null });
}

main().catch((e: unknown) => {
  // Print only the error code, never configuration values.
  stdoutSink({ ts: new Date().toISOString(), level: "error", msg: "api-start-failed", code: e instanceof Error ? e.message : "unknown" });
  process.exit(1);
});
