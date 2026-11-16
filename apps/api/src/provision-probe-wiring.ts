// DEVOS-234 (M2.4-d3c-1): the probe's provisioner, wired exactly as runtime.ts wires the sweep's (same modules, vault,
// M1.7 policy engine and S4 afterStack hook), so the probe exercises the production path. Never `allowAll`.
import { PolicyEngine, PrismaPolicyStore } from "@devos/policy";
import { PrismaVaultStore, Vault, parseVaultKey, parseVaultKeyVersion } from "./vault.js";
import { PrismaIsolationStore } from "./isolation-store.js";
import { buildProvisioner, PrismaProvisioningRows, type Provisioner, type ProvisionModule, type ProvisionWiring } from "./provision-runtime.js";

export async function stepWiring(db: any, databaseUrl: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ provisioner: Provisioner } | { off: string }> {
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
  let loaded: { mod: ProvisionModule; apply: ProvisionWiring["apply"]; isolationHook: (o: { store: PrismaIsolationStore }) => ProvisionWiring["afterStack"] };
  try {
    const provisionModuleName = "@devos/provision";
    const isolationModuleName = "@devos/isolation";
    const applyUrl = new URL("../../../scripts/template/apply.mjs", import.meta.url).href;
    const [mod, iso, tpl] = await Promise.all([import(provisionModuleName), import(isolationModuleName), import(applyUrl)]);
    loaded = { mod, apply: tpl.apply, isolationHook: iso.isolationHook };
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
  return "off" in pv ? pv : { provisioner: pv };
}
