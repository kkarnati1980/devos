// M2.4-c2a/c2c2 (docs/modules/M2.4.md, "What a project gets" row 4; the c2a and c2c2 notes): one git-based Coolify
// application per environment, cloned from the project repo with the c2c1 deploy key. The Compose that runs is the
// S4-hardened file committed by `github/deploy_compose` (deploy-compose.ts), named by `docker_compose_location` and
// also sent as `docker_compose_raw`, with `instant_deploy:false` (M2.4 deploys nothing). Create-or-get by name; the description
// carries the ownership marker, written in the create call itself (decision 3).

import { parse } from "yaml";
import type { CoolifyClient } from "./coolify.js";
import { CoreRepo } from "./core-repo.js";
import { deployComposeStep } from "./deploy-compose.js";
import type { GitHubClient } from "./github.js";
import { ProviderError } from "./http.js";
import { ownershipMarker, type Found, type ProvisionStore, type StepSpec } from "./runner.js";
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
/** M2.4-c2c2: a git-based application cloned with a private deploy key (Coolify API). */
export const APPLICATION_CREATE_PATH = "/api/v1/applications/private-deploy-key";
/** The service of the S3 core that serves HTTP, and the port it listens on (templates/golden-path/core/Dockerfile). */
export const APP_SERVICE = "app";
export const APP_CONTAINER_PORT = 3000;

/** True for a dotted IPv4 address inside the tailnet range 100.64.0.0/10, written without leading zeros. */
export function isTailnetIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const o = m.slice(1, 5).map((x) => (x.length > 1 && x.startsWith("0") ? NaN : Number(x)));
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Publishes the stack's tailnet port (row 6) on the core's `app` service, after S4's hook (S4 drops every `ports`
 * entry and leaves publishing to M2.4-c2). The binding is `<tailnet ip>:<port> -> 3000/tcp` only: never 0.0.0.0, so the
 * stack is reachable on the tailnet and nowhere else (decision 1). Returns a new document; refuses rather than guesses.
 */
export function publishTailnetPort(compose: Record<string, unknown>, port: number, bindHost: string): Record<string, unknown> {
  if (!isTailnetIpv4(bindHost)) throw new Error("tailnet-ip-invalid");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("coolify-port-invalid");
  const services = compose.services as Record<string, unknown> | undefined;
  if (!services || typeof services !== "object" || Array.isArray(services)) throw new Error("compose-invalid: no services");
  const app = services[APP_SERVICE] as Record<string, unknown> | undefined;
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new Error(`compose-invalid: no ${APP_SERVICE} service`);
  // S4 drops `ports` everywhere; any left means the hook did not run as specified, so nothing is published blind.
  for (const [n, svc] of Object.entries(services)) {
    if (svc && typeof svc === "object" && "ports" in (svc as object)) throw new Error(`compose-ports-unexpected: service ${n}`);
  }
  const ports = [{ target: APP_CONTAINER_PORT, published: String(port), host_ip: bindHost, protocol: "tcp", mode: "host" }];
  return { ...compose, services: { ...services, [APP_SERVICE]: { ...app, ports } } };
}

/** The single binding `publishTailnetPort` writes; anything else in a deploy file is refused before the create. */
export function assertPublished(compose: unknown, port: number, bindHost: string): void {
  const services = (compose as { services?: unknown } | null)?.services as Record<string, unknown> | undefined;
  if (!services || typeof services !== "object" || Array.isArray(services)) throw new Error("compose-invalid: no services");
  const want = JSON.stringify([{ target: APP_CONTAINER_PORT, published: String(port), host_ip: bindHost, protocol: "tcp", mode: "host" }]);
  for (const [n, svc] of Object.entries(services)) {
    const ports = svc && typeof svc === "object" ? (svc as { ports?: unknown }).ports : undefined;
    if (n === APP_SERVICE ? JSON.stringify(ports) !== want : ports !== undefined) throw new Error(`compose-ports-unexpected: service ${n}`);
  }
}

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
  /** The DevOS server's tailnet IPv4 (`DEVOS_TAILNET_IP`, set by the M2.4-d wiring): the only address a stack binds. */
  tailnetIp: string;
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
  if (typeof opts.tailnetIp !== "string" || !isTailnetIpv4(opts.tailnetIp)) throw new Error("tailnet-ip-invalid");
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
      // M2.4-c2c2: the source is the project repo, cloned with the c2c1 key; the Compose that runs is the committed
      // hardened file (`github/deploy_compose`), so Coolify's stored copy and the repo agree either way.
      const deployCommit = await done("github/deploy_compose", "deploy-compose-not-committed");
      if (!/^[0-9a-f]{40}$/.test(deployCommit)) throw new Error("deploy-compose-commit-invalid");
      await done("github/deploy_key", "github-deploy-key-not-provisioned");
      const privateKeyUuid = await done("coolify/deploy_key", "coolify-deploy-key-not-provisioned");
      if (!UUID_RE.test(privateKeyUuid)) throw new Error("coolify-uuid-invalid");

      const repo = new CoreRepo(gh.http, opts.owner, `devos-${p.slug}`);
      const path = `deploy/compose.${env}.devos.yaml`;
      const entry = (await repo.treeOf(deployCommit)).get(path);
      if (!entry) throw new Error(`compose-missing: the deploy commit has no ${path}`);
      const bytes = await repo.blobContent(entry.sha);
      // Defence in depth: the file must still publish exactly this stack's tailnet port on `app`, and nothing else.
      assertPublished(parseCompose(bytes), Number(port), opts.tailnetIp);

      // The reads above are awaits after the runner's last lock check (Codex PR50-r1): check again.
      await store.assertLockHeld(p.id);
      const r = await cf.http.write<{ uuid?: unknown }>("POST", APPLICATION_CREATE_PATH, {
        project_uuid: projectUuid,
        server_uuid: opts.serverUuid,
        environment_name: env,
        name,
        description: `DevOS ${p.slug} ${hookEnvName(env)} stack ${marker}`,
        private_key_uuid: privateKeyUuid,
        git_repository: `git@github.com:${opts.owner}/devos-${p.slug}.git`,
        git_branch: "main",
        build_pack: "dockercompose",
        // Pre-review: Coolify's git-based create requires the exposed port (the core app listens on 3000).
        ports_exposes: String(APP_CONTAINER_PORT),
        docker_compose_location: `/${path}`,
        // The same bytes as the committed file, so Coolify's stored copy equals it whether or not it re-reads the repo.
        docker_compose_raw: bytes.toString("base64"),
        instant_deploy: false,
        // Decision 1: tailnet only; Coolify must not generate a proxy domain (Codex PR76-r1).
        autogenerate_domain: false,
      });
      const uuid = r.body?.uuid;
      if (typeof uuid !== "string" || !UUID_RE.test(uuid)) {
        // The POST answered 2xx, so the application probably exists: transient, so the runner looks it up (pre-review).
        throw new ProviderError("coolify", "timeout", `coolify POST ${APPLICATION_CREATE_PATH} returned no uuid`, r.status);
      }
      // Read back by listing, so the marker that proves ownership is the one Coolify stored.
      const got = (await listApplications(cf)).find((a) => a.uuid === uuid);
      if (!got) throw new ProviderError("coolify", "timeout", "coolify application not listed yet after create", r.status);
      return toFound(got);
    },
  };
}

/**
 * The M2.4-c2a/c2c2 steps, in order after the environments, ports and deploy keys: the committed deploy Compose, then
 * one git-based application per environment.
 */
export function applicationSteps(cf: CoolifyClient, gh: GitHubClient, store: ProvisionStore, p: { id: string; slug: string }, opts: ApplicationOptions): StepSpec[] {
  return [deployComposeStep(gh, store, p, opts), ...STACK_ENVS.map((e) => applicationStep(cf, gh, store, p, e, opts))];
}
