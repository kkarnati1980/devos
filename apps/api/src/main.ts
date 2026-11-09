// Entry point. Secrets are read by name from the environment (Coolify env / server vault), never logged.
import { createApp } from "./app.js";
import { KkSessionRegistry } from "./auth.js";
import { loadConfig, loadTls, startupErrorCode } from "./config.js";
import { stdoutSink } from "./http.js";
import { TailscaleWhoisResolver } from "./identity.js";
import { buildRuntime, type DbClient } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // R3-a: read the certificate files before anything else starts, so a missing file stops start-up early.
  const tls = loadTls(process.env, config.secureCookies);
  const kkSessions = new KkSessionRegistry();
  const { grants, readiness, setup, notify } = await buildRuntime(process.env, {
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
    setup,
    notify,
    tls,
  });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  stdoutSink({ ts: new Date().toISOString(), level: "info", msg: "api-started", port: config.port, tls: tls !== null, policyEngine: grants !== null, vault: setup.vault !== null, notifications: notify.notifier !== null });
}

main().catch((e: unknown) => {
  // Print only a controlled code, never e.message or configuration values (PR14-r2).
  stdoutSink({ ts: new Date().toISOString(), level: "error", msg: "api-start-failed", code: startupErrorCode(e) });
  process.exit(1);
});
