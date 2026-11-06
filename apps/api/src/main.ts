// Entry point. Secrets are read by name from the environment (Coolify env / server vault), never logged.
import { PolicyEngine, PrismaPolicyStore, type PrismaLike } from "@devos/policy";
import { createApp } from "./app.js";
import { KkSessionRegistry } from "./auth.js";
import { loadConfig } from "./config.js";
import { stdoutSink, withTimeout } from "./http.js";
import { TailscaleWhoisResolver } from "./identity.js";
import type { GrantService, ReadinessProbe } from "./routes.js";

interface DbClient extends PrismaLike {
  $queryRawUnsafe(sql: string): Promise<unknown>;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const kkSessions = new KkSessionRegistry();
  let grants: GrantService | null = null;
  let readiness: ReadinessProbe = async () => {
    throw new Error("database-not-configured");
  };

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    // Resolved at runtime so the API typechecks without the generated Prisma client (built in CI).
    const dbModuleName = "@devos/db";
    const { createDb } = (await import(dbModuleName)) as { createDb: (url: string) => DbClient };
    const db = createDb(databaseUrl);
    readiness = () => withTimeout(() => db.$queryRawUnsafe("SELECT 1"), config.outboundTimeoutMs, "db-timeout").then(() => undefined);
    const hmac = process.env.DEVOS_POLICY_HMAC_KEY;
    if (hmac) {
      grants = new PolicyEngine({
        store: new PrismaPolicyStore(db),
        hmacKey: Buffer.from(hmac, "utf8"),
        verifyKkSession: kkSessions.verify,
      }) as unknown as GrantService;
    }
  }

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
