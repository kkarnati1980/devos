// M2.4-c1 (docs/modules/M2.4.md, "What a project gets" rows 3 and 6; decisions 1 and 2): the Coolify
// environments `preview` and `production`, and one tailnet host port per environment from the project port range.

import type { CoolifyClient } from "./coolify.js";
import { ProviderError } from "./http.js";
import { StepError, type Found, type ProvisionStore, type StepSpec } from "./runner.js";

export type StackEnv = "preview" | "production";
export const STACK_ENVS: readonly StackEnv[] = ["preview", "production"];

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface EnvBody {
  name: string;
}

/** `GET /projects/{uuid}/environments` (M0.4 04b): only a 200 with an array of named entries proves absence. */
async function listEnvironments(cf: CoolifyClient, projectUuid: string): Promise<EnvBody[]> {
  if (!UUID_RE.test(projectUuid)) throw new Error("coolify-uuid-invalid");
  const r = await cf.http.get<EnvBody[]>(`/api/v1/projects/${projectUuid}/environments`);
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/projects/{uuid}/environments returned an unexpected response (${r.status})`, r.status);
  }
  for (const x of r.body as unknown[]) {
    const e = x as Partial<EnvBody> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string") {
      throw new ProviderError("coolify", "bad-response", "coolify environments list has a malformed entry", r.status);
    }
  }
  return r.body;
}

/**
 * A Coolify environment of the project's Coolify project. Environments carry no description, so ownership comes
 * from the parent: the `coolify/project` step has already proven that project carries this project's marker, and
 * its uuid is read from the journal (a `done` row), never from user input. External id: `<project uuid>/<env>`.
 */
export function coolifyEnvironmentStep(cf: CoolifyClient, store: ProvisionStore, projectId: string, env: StackEnv): StepSpec {
  const parentUuid = async (): Promise<string> => {
    const s = await store.getStep(projectId, "coolify/project");
    if (s?.status !== "done" || !s.externalId) throw new Error("coolify-project-not-provisioned");
    return s.externalId;
  };
  const found = (uuid: string): Found => ({ externalId: `${uuid}/${env}`, name: env, owned: true });
  return {
    key: `coolify/environment/${env}`,
    provider: "coolify",
    kind: "environment",
    name: env,
    action: "provision.coolify.environment",
    lookup: async () => {
      const uuid = await parentUuid();
      return (await listEnvironments(cf, uuid)).some((e) => e.name === env) ? found(uuid) : null;
    },
    create: async () => {
      const uuid = await parentUuid();
      // Codex PR50-r1: the journal read above is an await after the runner's last lock check; check again.
      await store.assertLockHeld(projectId);
      await cf.http.write("POST", `/api/v1/projects/${uuid}/environments`, { name: env });
      return found(uuid);
    },
  };
}

/** The project port range (`DEVOS_PROJECT_PORTS`, default 20000–20999): preview gets even ports, production odd. */
export interface PortRange {
  from: number;
  to: number;
}

export function parsePortRange(raw: string | undefined): PortRange {
  const v = (raw ?? "20000-20999").trim();
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(v);
  if (!m) throw new Error("port-range-invalid: expected <from>-<to>");
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1024 || to > 65535 || from >= to) throw new Error("port-range-invalid: must be within 1024–65535, from < to");
  return { from, to };
}

/**
 * A stable host port for one stack, allocated through the inventory (`coolify/port`, external id = the port).
 * The unique (provider, kind, external id) index makes the allocation race-free across projects: a port another
 * project took first fails the insert (`resource_owned_elsewhere`) and the next free port is tried. A port ever
 * held by another project (even a purged one) is not reused. Re-runs find this project's row by its name and keep it.
 */
export function portStep(store: ProvisionStore, p: { id: string; slug: string }, env: StackEnv, range: PortRange): StepSpec {
  if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
  const name = `${p.slug}/${env}`;
  const key = `coolify/port/${env}`;
  const parity = env === "preview" ? 0 : 1;
  return {
    key,
    provider: "coolify",
    kind: "port",
    name,
    action: "provision.coolify.port",
    lookup: async () => {
      const mine = (await store.listResources("coolify", "port")).find((r) => r.projectId === p.id && r.name === name && r.active);
      return mine ? { externalId: mine.externalId, name, owned: true } : null;
    },
    create: async () => {
      const all = await store.listResources("coolify", "port");
      // Codex PR50-r1: never allocate a second port for this stack. If our row exists (a run that lost the lock
      // inserted it), adopt it; and re-check the lock after the read, right before every insert.
      const own = all.find((r) => r.projectId === p.id && r.name === name && r.active);
      if (own) return { externalId: own.externalId, name, owned: true };
      const used = new Set(all.map((r) => r.externalId));
      for (let port = range.from + ((range.from % 2 === parity) ? 0 : 1); port <= range.to; port += 2) {
        const id = String(port);
        if (used.has(id)) continue;
        await store.assertLockHeld(p.id);
        try {
          await store.recordResource(p.id, { provider: "coolify", kind: "port", externalId: id, name });
          return { externalId: id, name, owned: true };
        } catch (e) {
          if (e instanceof Error && e.message === "resource_owned_elsewhere") continue; // taken concurrently
          throw e;
        }
      }
      throw new StepError(key, "port_range_exhausted", false, true, `no free ${env} port in ${range.from}–${range.to}`);
    },
  };
}

/** The M2.4-c1 steps for one project, in order: environments, then ports (after the `coolify/project` step). */
export function stackSteps(cf: CoolifyClient, store: ProvisionStore, p: { id: string; slug: string }, range: PortRange): StepSpec[] {
  return [
    ...STACK_ENVS.map((e) => coolifyEnvironmentStep(cf, store, p.id, e)),
    ...STACK_ENVS.map((e) => portStep(store, p, e, range)),
  ];
}
