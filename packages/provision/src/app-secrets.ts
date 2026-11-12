// M2.4-c2b (docs/modules/M2.4.md, row 5, decision 7, AT7): generated app secrets per stack, written as Coolify
// application env vars and sealed in the vault under the project (`vault_secret.project_id`). A value is generated
// here, handed to the vault port and to one Coolify write, and then dropped: it is never returned, logged, journalled
// or put in an error message. Not an inventory row (DEVOS-131): the teardown's vault scanner deletes the project's
// secrets by project id, and the env vars go with the application.

import { randomBytes } from "node:crypto";
import type { CoolifyClient } from "./coolify.js";
import { ProviderError } from "./http.js";
import { STACK_ENVS, type StackEnv } from "./stack.js";
import type { ProvisionStore, StepSpec } from "./runner.js";

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The secrets every stack gets (row 5). Names are env-var keys; values are 32 random bytes, base64url. */
export const APP_SECRET_NAMES = ["SESSION_SECRET", "DB_PASSWORD"] as const;
export type AppSecretName = (typeof APP_SECRET_NAMES)[number];

/** The vault, scoped to one project. Implemented in apps/api over `Vault` (M1.4); names are `<env>/<NAME>`. */
export interface ProjectSecrets {
  has(projectId: string, name: string): Promise<boolean>;
  /** Seals and stores (or rotates) the value; returns nothing about it. */
  put(projectId: string, name: string, value: string): Promise<void>;
}

/**
 * `GET /applications/{uuid}/envs`: the keys of the application's normal deployment. Coolify's `is_preview` marks a
 * variable for pull-request preview deployments, not our preview stack (each stack is its own application), so
 * entries with `is_preview: true` are ignored (pre-review). Values are never kept.
 */
export async function envKeys(cf: CoolifyClient, appUuid: string): Promise<Set<string>> {
  if (!UUID_RE.test(appUuid)) throw new Error("coolify-uuid-invalid");
  const r = await cf.http.get<unknown[]>(`/api/v1/applications/${appUuid}/envs`);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/applications/{uuid}/envs returned an unexpected response (${r.status})`, r.status);
  }
  const keys = new Set<string>();
  for (const x of r.body) {
    const e = x as { key?: unknown; is_preview?: unknown } | null;
    if (!e || typeof e !== "object" || typeof e.key !== "string") {
      throw new ProviderError("coolify", "bad-response", "coolify envs list has a malformed entry", r.status);
    }
    if (e.is_preview !== true) keys.add(e.key);
  }
  return keys;
}

export function appSecretStep(cf: CoolifyClient, store: ProvisionStore, secrets: ProjectSecrets, p: { id: string; slug: string }, env: StackEnv, secret: AppSecretName): StepSpec {
  if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
  if (!secrets || typeof secrets.has !== "function" || typeof secrets.put !== "function") throw new Error("project-secrets-required");
  const vaultName = `${env}/${secret}`;
  const externalId = `${p.slug}/${env}/${secret}`;
  const appUuid = async (): Promise<string> => {
    const s = await store.getStep(p.id, `coolify/application/${env}`);
    if (s?.status !== "done" || !s.externalId || !UUID_RE.test(s.externalId)) throw new Error("coolify-application-not-provisioned");
    return s.externalId;
  };
  return {
    key: `vault/app_secret/${env}/${secret}`,
    provider: "vault",
    kind: "app_secret",
    name: externalId,
    action: "provision.vault.app_secret",
    inventory: false,
    // Present only when both halves exist: the sealed copy and the application's env var.
    lookup: async () => {
      const uuid = await appUuid();
      const inVault = await secrets.has(p.id, vaultName);
      return inVault && (await envKeys(cf, uuid)).has(secret) ? { externalId, name: externalId, owned: true } : null;
    },
    create: async () => {
      const uuid = await appUuid();
      const present = (await envKeys(cf, uuid)).has(secret);
      // A half-done earlier run (vault written, env var not, or the reverse) is finished by a rotation: nothing is
      // deployed by M2.4, so a new value is harmless, and reading a stored value back is never needed.
      const value = randomBytes(32).toString("base64url");
      const body = { key: secret, value, is_preview: false, is_literal: true };
      // Write order makes an unconfirmed write safe: the half written LAST is the one the lookup can trust.
      // - Key absent (POST): vault first, then Coolify. If the POST's outcome is unknown, the key is present only
      //   if this value landed, so the lookup's "both halves" means both hold this value.
      // - Key present, vault missing (PATCH): Coolify first, then vault (second pre-review). If the PATCH's outcome
      //   is unknown, the vault is still missing, the lookup finds nothing, and the next run rotates both again.
      // The lock is checked right before each write (the reads above are awaits after the runner's last check).
      if (present) {
        await store.assertLockHeld(p.id);
        await cf.http.write("PATCH", `/api/v1/applications/${uuid}/envs`, body);
        await store.assertLockHeld(p.id);
        await secrets.put(p.id, vaultName, value);
      } else {
        await store.assertLockHeld(p.id);
        await secrets.put(p.id, vaultName, value);
        await store.assertLockHeld(p.id);
        await cf.http.write("POST", `/api/v1/applications/${uuid}/envs`, body);
      }
      return { externalId, name: externalId, owned: true };
    },
  };
}

/** The M2.4-c2b steps, after the applications: every secret for every stack. */
export function appSecretSteps(cf: CoolifyClient, store: ProvisionStore, secrets: ProjectSecrets, p: { id: string; slug: string }): StepSpec[] {
  return STACK_ENVS.flatMap((e) => APP_SECRET_NAMES.map((n) => appSecretStep(cf, store, secrets, p, e, n)));
}
