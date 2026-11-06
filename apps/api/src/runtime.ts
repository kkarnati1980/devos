// Runtime wiring of the database-backed parts (readiness + policy engine), kept out of main.ts so it is testable.
// Secrets are read by name only and never logged.
import { PolicyEngine, PrismaPolicyStore, type PrismaLike } from "@devos/policy";
import type { KkSessionRegistry } from "./auth.js";
import { withTimeout } from "./http.js";
import type { GrantService, ReadinessProbe, SetupServices } from "./routes.js";
import { PrismaSettingsStore } from "./settings.js";
import type { NotifyServices } from "./notify-routes.js";
import { Notifier, PrismaNotificationStore, parseDashboardUrl } from "./notify.js";
import { parseSmtpConfig } from "./smtp.js";
import { PrismaVaultStore, Vault, parseVaultKey, parseVaultKeyVersion } from "./vault.js";

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
  /** M1.4: settings need the database; the vault also needs `DEVOS_VAULT_KEY`. */
  setup: SetupServices;
  /** M1.6: notifications need the database; the bell and email also need their configuration. */
  notify: NotifyServices;
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
  // A malformed vault key stops start-up with a code (never the value), even before the database.
  const vaultKey = parseVaultKey(env.DEVOS_VAULT_KEY);
  const vaultKeyVersion = parseVaultKeyVersion(env.DEVOS_VAULT_KEY_VERSION);
  // M1.6: a malformed SMTP setting or dashboard URL also stops start-up with a code.
  const smtp = parseSmtpConfig(env);
  const dashboardUrl = parseDashboardUrl(env.DEVOS_DASHBOARD_URL);
  const noSetup: SetupServices = { settings: null, vault: null };
  const noNotify: NotifyServices = { notifier: null };
  if (!databaseUrl) return { grants: null, readiness: notReady("database-not-configured"), setup: noSetup, notify: noNotify };
  if (!hmac) return { grants: null, readiness: notReady("policy-not-configured"), setup: noSetup, notify: noNotify };
  const db = await opts.loadDb(databaseUrl);
  const setup: SetupServices = {
    settings: new PrismaSettingsStore(db, opts.outboundTimeoutMs),
    vault: vaultKey ? new Vault(new PrismaVaultStore(db, opts.outboundTimeoutMs), vaultKey, vaultKeyVersion) : null,
  };
  const grants = new PolicyEngine({
    store: new PrismaPolicyStore(db),
    hmacKey: Buffer.from(hmac, "utf8"),
    verifyKkSession: opts.kkSessions.verify,
  }) as unknown as GrantService;
  const vault = setup.vault;
  const notifier = new Notifier(new PrismaNotificationStore(db, opts.outboundTimeoutMs), {
    // The bell key and SMTP password are vault secrets (entered in the wizard), read at send time.
    secrets: vault
      ? { reveal: (name) => vault.reveal(name), isSet: async (name) => (await vault.list()).some((m) => m.name === name && m.set) }
      : null,
    smtp,
    dashboardUrl,
    timeoutMs: opts.outboundTimeoutMs,
  });
  return { grants, readiness: dbReadiness(db, opts.outboundTimeoutMs), setup, notify: { notifier } };
}
