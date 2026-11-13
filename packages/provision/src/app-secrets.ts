// M2.4-c2b (docs/modules/M2.4.md, "What a project gets" row 5; decision 7; AT7): the generated app secrets of each
// environment, written as Coolify application env vars and sealed in the vault under a project-scoped `put`.
// A generated value lives only in this file's `create` closure, the vault `put` call and the Coolify env-var body:
// never in a log line, a route, a journal row (`provision_step`), an audit event or a repo file.

import { randomBytes } from "node:crypto";
import type { CoolifyClient } from "./coolify.js";
import { ProviderError } from "./http.js";
import type { Found, ProvisionStore, StepSpec } from "./runner.js";
import { STACK_ENVS, type StackEnv } from "./stack.js";

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Row 5: the secrets every stack gets. The core uses neither yet; the add-ons (database, auth) read them. */
export const APP_SECRET_NAMES = ["SESSION_SECRET", "DB_PASSWORD"] as const;
export type AppSecretName = (typeof APP_SECRET_NAMES)[number];

/** 32 random bytes, base64url (43 characters): printable, no whitespace, valid in a Compose env var unquoted. */
export const generateAppSecret = (): string => randomBytes(32).toString("base64url");

/** The vault name of one app secret, unique per project: `<env>/<NAME>` (e.g. `preview/SESSION_SECRET`). */
export const appSecretVaultName = (env: StackEnv, key: string): string => `${env}/${key}`;

/**
 * The project-scoped vault port (implemented in apps/api by `Vault.hasProject` / `Vault.putProject`). `put` stores
 * the value encrypted under this project's id (`vault_secret.project_id`) and returns nothing about it.
 */
export interface ProjectSecrets {
  has(projectId: string, name: string): Promise<boolean>;
  put(projectId: string, name: string, value: string): Promise<void>;
}

interface EnvBody {
  key: string;
  is_preview?: boolean;
}

/**
 * The env-var keys of one Coolify application (`GET /api/v1/applications/{uuid}/envs`). Coolify returns values too;
 * they are dropped here, so no value outlives this call. Only a 200 with an array of keyed entries is conclusive.
 * Coolify's `is_preview` entries belong to pull-request preview deployments, which DevOS does not use: only the
 * normal (non-preview) keys count.
 */
export async function listAppEnvKeys(cf: CoolifyClient, appUuid: string): Promise<Set<string>> {
  if (!UUID_RE.test(appUuid)) throw new Error("coolify-uuid-invalid");
  const r = await cf.http.get<unknown>(`/api/v1/applications/${appUuid}/envs`);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/applications/{uuid}/envs returned an unexpected response (${r.status})`, r.status);
  }
  const keys = new Set<string>();
  for (const x of r.body as unknown[]) {
    const e = x as Partial<EnvBody> | null;
    if (!e || typeof e !== "object" || typeof e.key !== "string" || (e.is_preview !== undefined && typeof e.is_preview !== "boolean")) {
      throw new ProviderError("coolify", "bad-response", "coolify env list has a malformed entry", r.status);
    }
    if (e.is_preview !== true) keys.add(e.key);
  }
  return keys;
}

/**
 * One generated app secret of one environment. Step key `vault/app_secret/<env>/<NAME>`, external id
 * `<slug>/<env>/<NAME>`, not an inventory row (DEVOS-131: teardown deletes app secrets by `project_id`, and the
 * Coolify env vars go with their application).
 *
 * Present = the vault holds it AND the application lists the key. Anything else is (re)created: generate, seal in
 * the vault (a rotation if a row exists), then write the env var (`PATCH` when the key exists, else `POST`). A crash
 * between the two writes re-runs as a rotation, which is harmless because M2.4 deploys nothing.
 */
export function appSecretStep(cf: CoolifyClient, store: ProvisionStore, secrets: ProjectSecrets, p: { id: string; slug: string }, env: StackEnv, key: AppSecretName): StepSpec {
  if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
  if (!KEY_RE.test(key)) throw new Error("app-secret-name-invalid");
  if (!secrets || typeof secrets.has !== "function" || typeof secrets.put !== "function") throw new Error("project-secrets-required");
  const vaultName = appSecretVaultName(env, key);
  const externalId = `${p.slug}/${env}/${key}`;
  const found: Found = { externalId, name: externalId, owned: true };

  const appUuid = async (): Promise<string> => {
    const s = await store.getStep(p.id, `coolify/application/${env}`);
    if (s?.status !== "done" || !s.externalId) throw new Error("coolify-application-not-provisioned");
    if (!UUID_RE.test(s.externalId)) throw new Error("coolify-uuid-invalid");
    return s.externalId;
  };

  return {
    key: `vault/app_secret/${env}/${key}`,
    provider: "vault",
    kind: "app_secret",
    name: externalId,
    action: "provision.vault.app_secret",
    inventory: false,
    lookup: async () => {
      const uuid = await appUuid();
      if (!(await secrets.has(p.id, vaultName))) return null;
      return (await listAppEnvKeys(cf, uuid)).has(key) ? found : null;
    },
    create: async () => {
      const uuid = await appUuid();
      const exists = (await listAppEnvKeys(cf, uuid)).has(key);
      const value = generateAppSecret();
      // The reads above are awaits after the runner's last lock check (Codex PR50-r1): check before each write.
      await store.assertLockHeld(p.id);
      await secrets.put(p.id, vaultName, value);
      await store.assertLockHeld(p.id);
      // `is_literal`: Coolify must not interpolate `$` sequences; `is_preview:false`: the normal deployment's value.
      await cf.http.write(exists ? "PATCH" : "POST", `/api/v1/applications/${uuid}/envs`, { key, value, is_preview: false, is_literal: true });
      return found;
    },
  };
}

/** The M2.4-c2b steps, after the applications: each environment's app secrets, in a fixed order. */
export function appSecretSteps(cf: CoolifyClient, store: ProvisionStore, secrets: ProjectSecrets, p: { id: string; slug: string }): StepSpec[] {
  return STACK_ENVS.flatMap((e) => APP_SECRET_NAMES.map((k) => appSecretStep(cf, store, secrets, p, e, k)));
}
