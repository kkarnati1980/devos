// M2.4-c2a (docs/modules/M2.4.md, "What a project gets" row 4; "M2.4-c2 split and c2a build notes"): one Coolify
// application per environment, built with Compose from the project repo. The Compose is read from the repo at the
// core commit, hardened by S4's `afterStack` hook (required: no hook, no application) and handed to Coolify as
// `docker_compose_raw`, with `instant_deploy:false` (M2.4 deploys nothing). Create-or-get by name; the description
// carries the ownership marker, written in the create call itself (decision 3).

import { parse, stringify } from "yaml";
import type { CoolifyClient } from "./coolify.js";
import { CoreRepo } from "./core-repo.js";
import type { GitHubClient } from "./github.js";
import { ProviderError } from "./http.js";
import { ownershipMarker, StepError, type Found, type ProvisionStore, type StepSpec } from "./runner.js";
import { STACK_ENVS, type PortRange, type StackEnv } from "./stack.js";

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PORT_RE = /^[1-9]\d{3,4}$/;
/** The Compose file of the S3 core (templates/golden-path/core/compose.yaml). */
export const COMPOSE_PATH = "compose.yaml";
/** A Compose file larger than this is refused before parsing (the core's is under 1 KB). */
export const COMPOSE_MAX_BYTES = 64 * 1024;
/** The S4 hook runs while the project lock is held, so it is bounded like every other await (ADR-0011 §9). */
export const HOOK_TIMEOUT_MS = 30_000;

/** S4 names the production stack `live` (packages/isolation, StackEnv); M2.4 keeps Coolify's `production`. */
export const hookEnvName = (env: StackEnv): "preview" | "live" => (env === "production" ? "live" : "preview");
/** Row 4's deterministic names: `devos-<slug>-preview`, `devos-<slug>-live`. */
export const applicationName = (slug: string, env: StackEnv): string => `devos-${slug}-${hookEnvName(env)}`;

/** S4's `provision.hooks.afterStack(project, env)` (docs/modules/S4.md decision 7). It may refuse by throwing. */
export type AfterStack = (
  project: { id: string; slug: string },
  env: { name: "preview" | "live"; port: number; portRangeStart: number; compose: unknown },
) => Promise<{ compose: Record<string, unknown> }>;

export interface ProvisionHooks {
  afterStack: AfterStack;
}

interface AppBody {
  uuid: string;
  name: string;
  description?: string | null;
}

/** `GET /api/v1/applications`: only a 200 with an array of well-formed entries proves absence (Codex PR44-r1/r2). */
export async function listApplications(cf: CoolifyClient): Promise<AppBody[]> {
  const r = await cf.http.get<AppBody[]>("/api/v1/applications");
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/applications returned an unexpected response (${r.status})`, r.status);
  }
  for (const x of r.body as unknown[]) {
    const e = x as Partial<AppBody> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string" || typeof e.uuid !== "string" || !UUID_RE.test(e.uuid)) {
      throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/applications returned a malformed entry", r.status);
    }
    if (e.description != null && typeof e.description !== "string") {
      throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/applications returned a malformed description", r.status);
    }
  }
  return r.body;
}

/** Parses a Compose file; anchors and aliases are resolved, a `<<` merge key stays a literal key (S4 refuses it). */
export function parseCompose(buf: Buffer): unknown {
  if (buf.length > COMPOSE_MAX_BYTES) throw new Error("compose-too-large");
  let doc: unknown;
  try {
    doc = parse(buf.toString("utf8"), { merge: false, uniqueKeys: true, maxAliasCount: 100, prettyErrors: false });
  } catch {
    throw new Error("compose-invalid: not valid YAML");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("compose-invalid: not a mapping");
  return doc;
}

export interface ApplicationOptions {
  owner: string;
  /** The Coolify server the stacks run on (`DEVOS_COOLIFY_SERVER_UUID`, set by the M2.4-d wiring). */
  serverUuid: string;
  range: PortRange;
  hooks: ProvisionHooks;
  /** Tests only: a shorter hook bound. */
  hookTimeoutMs?: number;
}

/**
 * The Coolify application of one environment. Inputs come only from this project's `done` journal rows (the Coolify
 * project uuid, the stack port and the core commit), never from user input; a missing row fails before any call.
 */
export function applicationStep(cf: CoolifyClient, gh: GitHubClient, store: ProvisionStore, p: { id: string; slug: string }, env: StackEnv, opts: ApplicationOptions): StepSpec {
  if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
  if (!UUID_RE.test(opts.serverUuid)) throw new Error("coolify-server-uuid-invalid");
  if (!opts.hooks || typeof opts.hooks.afterStack !== "function") throw new Error("provision-hooks-required: afterStack (S4) must be registered");
  const name = applicationName(p.slug, env);
  const marker = ownershipMarker(p.id);
  const toFound = (a: AppBody): Found => ({ externalId: a.uuid, name: a.name, owned: (a.description ?? "").includes(marker) });

  const done = async (key: string, err: string): Promise<string> => {
    const s = await store.getStep(p.id, key);
    if (s?.status !== "done" || !s.externalId) throw new Error(err);
    return s.externalId;
  };

  return {
    key: `coolify/application/${env}`,
    provider: "coolify",
    kind: "application",
    name,
    action: "provision.coolify.application",
    lookup: async () => {
      const all = (await listApplications(cf)).filter((a) => a.name === name);
      // Prefer one we own; a same-named application that is not ours is a conflict (decision 2). Two owned ones
      // (an earlier duplicate) are inconclusive: adopting either could hide the other (pre-review).
      const owned = all.filter((a) => toFound(a).owned);
      if (owned.length > 1) throw new ProviderError("coolify", "bad-response", `coolify lists ${owned.length} applications named ${name} for this project`, 200);
      const pick = owned[0] ?? all[0];
      return pick ? toFound(pick) : null;
    },
    create: async () => {
      const projectUuid = await done("coolify/project", "coolify-project-not-provisioned");
      if (!UUID_RE.test(projectUuid)) throw new Error("coolify-uuid-invalid");
      await done(`coolify/environment/${env}`, "coolify-environment-not-provisioned");
      const port = await done(`coolify/port/${env}`, "port-not-allocated");
      if (!PORT_RE.test(port)) throw new Error("coolify-port-invalid");
      const commit = await done("github/core", "core-not-pushed");

      const repo = new CoreRepo(gh.http, opts.owner, `devos-${p.slug}`);
      const entry = (await repo.treeOf(commit)).get(COMPOSE_PATH);
      if (!entry) throw new Error("compose-missing: the core commit has no compose.yaml");
      const compose = parseCompose(await repo.blobContent(entry.sha));
      // S4 hardens the Compose (limits, project network, allow-list) or refuses; a refusal creates nothing.
      const ms = opts.hookTimeoutMs ?? HOOK_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const hardened = await Promise.race([
        opts.hooks.afterStack({ id: p.id, slug: p.slug }, { name: hookEnvName(env), port: Number(port), portRangeStart: opts.range.from, compose }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepError(`coolify/application/${env}`, "provider_error", true, true, `afterStack hook did not finish within ${ms} ms`)), ms); }),
      ]).finally(() => clearTimeout(timer));
      if (!hardened || typeof hardened.compose !== "object" || hardened.compose === null || Array.isArray(hardened.compose)) throw new Error("after-stack-no-compose");

      // The reads and the hook above are awaits after the runner's last lock check (Codex PR50-r1): check again.
      await store.assertLockHeld(p.id);
      const r = await cf.http.write<{ uuid?: unknown }>("POST", "/api/v1/applications/dockercompose", {
        project_uuid: projectUuid,
        server_uuid: opts.serverUuid,
        environment_name: env,
        name,
        description: `DevOS ${p.slug} ${hookEnvName(env)} stack ${marker}`,
        docker_compose_raw: Buffer.from(stringify(hardened.compose), "utf8").toString("base64"),
        instant_deploy: false,
        // Decision 1: tailnet only; Coolify must not generate a proxy domain (Codex PR76-r1).
        autogenerate_domain: false,
      });
      const uuid = r.body?.uuid;
      if (typeof uuid !== "string" || !UUID_RE.test(uuid)) {
        // The POST answered 2xx, so the application probably exists: transient, so the runner looks it up (pre-review).
        throw new ProviderError("coolify", "timeout", "coolify POST /api/v1/applications/dockercompose returned no uuid", r.status);
      }
      // Read back by listing, so the marker that proves ownership is the one Coolify stored.
      const got = (await listApplications(cf)).find((a) => a.uuid === uuid);
      if (!got) throw new ProviderError("coolify", "timeout", "coolify application not listed yet after create", r.status);
      return toFound(got);
    },
  };
}

/** The M2.4-c2a steps, in order after the environments and ports: one application per environment. */
export function applicationSteps(cf: CoolifyClient, gh: GitHubClient, store: ProvisionStore, p: { id: string; slug: string }, opts: ApplicationOptions): StepSpec[] {
  return STACK_ENVS.map((e) => applicationStep(cf, gh, store, p, e, opts));
}
