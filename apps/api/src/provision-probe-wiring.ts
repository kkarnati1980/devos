// DEVOS-234 (M2.4-d3c-1): the probe's provisioner, wired exactly as runtime.ts wires the sweep's (same modules, vault,
// M1.7 policy engine and S4 afterStack hook), so the probe exercises the production path. Never `allowAll`.
import { PolicyEngine, PrismaPolicyStore, grantProblem } from "@devos/policy";
import { PrismaVaultStore, Vault, parseVaultKey, parseVaultKeyVersion } from "./vault.js";
import { PrismaIsolationStore } from "./isolation-store.js";
import { buildProvisioner, PrismaProvisioningRows, provisionConfig, vaultToken, type Provisioner, type ProvisionModule, type ProvisionWiring } from "./provision-runtime.js";
import type { ProvisionTeardownModule, TeardownModule, TeardownStoreLike } from "./provision-probe-purge.js";

/** d3c-2a: what the probe's purge is built from (decision 2), next to the provisioner it purges after. */
export interface PurgeKit {
  provisionMod: ProvisionTeardownModule;
  teardownMod: TeardownModule;
  gh: unknown;
  cf: unknown;
  owner: string;
  store: TeardownStoreLike;
  policy: { decide(r: unknown): Promise<{ enforcedOutcome: string }> };
  grantProblem: typeof grantProblem;
}

export async function stepWiring(db: any, databaseUrl: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ provisioner: Provisioner; purge: PurgeKit; vault: Vault } | { off: string }> {
  const hmac = env.DEVOS_POLICY_HMAC_KEY;
  if (!hmac) return { off: "policy-not-configured" };
  let vaultKey: Buffer | null;
  let vaultKeyVersion: number;
  try {
    vaultKey = parseVaultKey(env.DEVOS_VAULT_KEY);
    vaultKeyVersion = parseVaultKeyVersion(env.DEVOS_VAULT_KEY_VERSION);
  } catch {
    return { off: "provision-vault-not-configured" };
  }
  const vault = vaultKey ? new Vault(new PrismaVaultStore(db, timeoutMs), vaultKey, vaultKeyVersion) : null;
  // The probe acts as the system provisioner; it never needs a KK session.
  const engine = new PolicyEngine({ store: new PrismaPolicyStore(db), hmacKey: Buffer.from(hmac, "utf8"), verifyKkSession: () => false });
  let loaded: {
    mod: ProvisionModule;
    apply: ProvisionWiring["apply"];
    isolationHook: (o: { store: PrismaIsolationStore }) => ProvisionWiring["afterStack"];
    teardown: TeardownModule & { PrismaTeardownStore: new (db: unknown, o: Record<string, unknown>) => TeardownStoreLike };
  };
  try {
    const provisionModuleName = "@devos/provision";
    const isolationModuleName = "@devos/isolation";
    const teardownModuleName = "@devos/teardown";
    const applyUrl = new URL("../../../scripts/template/apply.mjs", import.meta.url).href;
    const [mod, iso, tpl, td] = await Promise.all([import(provisionModuleName), import(isolationModuleName), import(applyUrl), import(teardownModuleName)]);
    loaded = { mod, apply: tpl.apply, isolationHook: iso.isolationHook, teardown: td };
  } catch {
    return { off: "provision-load-failed" };
  }
  const pv = buildProvisioner({
    mod: loaded.mod,
    apply: loaded.apply,
    afterStack: loaded.isolationHook({ store: new PrismaIsolationStore(db, timeoutMs) }),
    db,
    databaseUrl,
    vault,
    policy: engine as unknown as ProvisionWiring["policy"],
    rows: new PrismaProvisioningRows(db, timeoutMs),
    // The probe's own slug can never take a real project's name (ensureProbeProject refuses `probe-slug-taken`), so a
    // name-conflict card means something is wrong: it fails the run instead of raising a card to KK.
    raiseCard: async () => { throw new Error("probe-name-conflict"); },
    log: () => {},
    env,
  });
  if ("off" in pv) return pv;
  const cfg = provisionConfig(env);
  if ("off" in cfg || !vault) return { off: "off" in cfg ? cfg.off : "provision-vault-not-configured" };
  const purge: PurgeKit = {
    provisionMod: loaded.mod as unknown as ProvisionTeardownModule,
    teardownMod: loaded.teardown,
    gh: new loaded.mod.GitHubClient({ token: vaultToken(vault, "github_token") }),
    cf: new loaded.mod.CoolifyClient({ origin: cfg.coolifyOrigin, token: vaultToken(vault, "coolify_api_token") }),
    owner: cfg.owner,
    // A purge waits at most 30 s for the project lock, so one tick stays inside the agent's check limit; a lock
    // still held is a throw, which probeStep treats as in progress.
    store: new loaded.teardown.PrismaTeardownStore(db, { databaseUrl, dbTimeoutMs: timeoutMs, lockWaitMs: 30_000 }),
    policy: engine as unknown as PurgeKit["policy"],
    grantProblem,
  };
  // DEVOS-110: the vault is also what the grant card's notice reads its delivery secrets from (as runtime.ts does).
  return { provisioner: pv, purge, vault };
}
