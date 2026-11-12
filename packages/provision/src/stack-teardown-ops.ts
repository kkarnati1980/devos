// M2.5-a3 (docs/modules/M2.5.md, "M2.5-a3 build notes"): teardown ops for what M2.4-c1 provisions — the Coolify
// environments `preview`/`production` (external id `<project uuid>/<env>`) and the inventory-only host ports.
// Same rules as teardown-ops.ts: only a 404 proves absence, a delete is one write, 404/410 on delete is "gone".

import { ProviderError } from "./http.js";
import type { CoolifyClient } from "./coolify.js";
import { ownershipMarker } from "./runner.js";
import { listEnvironments, STACK_ENVS, type StackEnv } from "./stack.js";
import type { InventoryItem, ResourceOps } from "./teardown-ops.js";

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const PORT_RE = /^[1-9]\d{3,4}$/;

function splitEnv(item: InventoryItem): [string, StackEnv] {
  const parts = item.externalId.split("/");
  const [uuid, env] = parts;
  if (parts.length !== 2 || !uuid || !UUID_RE.test(uuid) || !(STACK_ENVS as readonly string[]).includes(env ?? "") || item.name !== env) {
    throw new Error("coolify-environment-id-invalid");
  }
  return [uuid, env as StackEnv];
}

const gone = (e: unknown): boolean => e instanceof ProviderError && e.code === "http" && (e.status === 404 || e.status === 410);

/**
 * Coolify environment ops. Environments carry no description, so ownership is the parent project's marker
 * (the same rule M2.4-c1 used to create them). The parent project gone (404) means the environment is gone too.
 * Archive has nothing to stop here: an environment holds applications, which M2.5-a3b stops.
 */
export function coolifyEnvironmentOps(cf: CoolifyClient, projectId: string): ResourceOps {
  return {
    provider: "coolify",
    kind: "environment",
    inspect: async (item) => {
      const [uuid, env] = splitEnv(item);
      const r = await cf.http.get<{ uuid?: string; description?: string | null }>(`/api/v1/projects/${uuid}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body || typeof r.body !== "object" || r.body.uuid !== uuid) {
        throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/projects/{uuid} returned an inconclusive response (${r.status})`, r.status);
      }
      const owned = typeof r.body.description === "string" && r.body.description.includes(ownershipMarker(projectId));
      if (!(await listEnvironments(cf, uuid)).some((e) => e.name === env)) return null;
      return { owned };
    },
    remove: async (item) => {
      const [uuid, env] = splitEnv(item);
      try {
        await cf.http.write("DELETE", `/api/v1/projects/${uuid}/environments/${env}`);
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
  };
}

/**
 * Host-port ops. A port is an inventory row only (M2.4-c1 allocates it in the inventory; nothing exists at a
 * provider), so `inspect` reports nothing to delete and the purge just marks the row deleted. The row is kept
 * (status `deleted`), so the port is never handed to another project (M2.4-c1's no-reuse rule).
 */
export function coolifyPortOps(): ResourceOps {
  return {
    provider: "coolify",
    kind: "port",
    inspect: async (item) => {
      if (!PORT_RE.test(item.externalId) || Number(item.externalId) > 65535) throw new Error("coolify-port-invalid");
      return null;
    },
    remove: async () => {},
  };
}
