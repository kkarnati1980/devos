// Runtime wiring of the database-backed parts (readiness + policy engine), kept out of main.ts so it is testable.
// Secrets are read by name only and never logged.
import { PolicyEngine, PrismaPolicyStore, type PrismaLike } from "@devos/policy";
import type { KkSessionRegistry } from "./auth.js";
import { withTimeout } from "./http.js";
import type { GrantService, ReadinessProbe } from "./routes.js";

/** The subset of the Prisma client the API needs. */
export interface DbClient extends PrismaLike {
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: { isolationLevel?: string; timeout?: number; maxWait?: number }): Promise<T>;
}

/**
 * Readiness database probe with a bounded database operation (ADR-0011 §9, PR14-r1): the connection
 * wait is bounded by `maxWait`, the transaction by `timeout`, and `SELECT 1` by a transaction-local
 * `statement_timeout`, so a stalled database ends the operation itself, not only the wrapper.
 * The outer `withTimeout` keeps the HTTP answer within the same limit.
 */
export function dbReadiness(db: DbClient, timeoutMs: number): ReadinessProbe {
  return () =>
    withTimeout(
      () =>
        db.$transaction(
          async (t: any) => {
            await t.$queryRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true) AS statement_timeout`;
            await t.$queryRaw`SELECT 1 AS ready`;
          },
          { timeout: timeoutMs, maxWait: timeoutMs },
        ),
      timeoutMs,
      "db-timeout",
    ).then(() => undefined);
}

export interface Runtime {
  grants: GrantService | null;
  readiness: ReadinessProbe;
}

const notReady = (code: string): ReadinessProbe => async () => {
  throw new Error(code);
};

/**
 * Builds readiness and the grant service from the environment. Both `DATABASE_URL` and
 * `DEVOS_POLICY_HMAC_KEY` are required configuration (M1.2): if either is missing, grants are
 * disabled AND `/ready` is 503, so a deployment never reports ready while approvals cannot work.
 */
export async function buildRuntime(
  env: NodeJS.ProcessEnv,
  opts: { outboundTimeoutMs: number; kkSessions: KkSessionRegistry; loadDb: (url: string) => Promise<DbClient> },
): Promise<Runtime> {
  const databaseUrl = env.DATABASE_URL;
  const hmac = env.DEVOS_POLICY_HMAC_KEY;
  if (!databaseUrl) return { grants: null, readiness: notReady("database-not-configured") };
  if (!hmac) return { grants: null, readiness: notReady("policy-not-configured") };
  const db = await opts.loadDb(databaseUrl);
  const grants = new PolicyEngine({
    store: new PrismaPolicyStore(db),
    hmacKey: Buffer.from(hmac, "utf8"),
    verifyKkSession: opts.kkSessions.verify,
  }) as unknown as GrantService;
  return { grants, readiness: dbReadiness(db, opts.outboundTimeoutMs) };
}
