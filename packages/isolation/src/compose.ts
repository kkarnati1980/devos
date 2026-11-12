// S4 decision 6 (limits, DV-NFR-05; unsafe options) and decision 1 (one project network): the Compose that
// M2.4-c hands to Coolify is validated and rewritten here. Pure: it never reads files, the host or Docker.
//
// S4-a decision 4 (pre-review, 12 Nov 2026): an ALLOW-LIST. A Compose key that is not listed here is refused
// (compose_unsafe), so a Compose feature we did not think of fails closed instead of reaching the host.
import { IsolationError } from "./errors.js";
import type { StackEnv, StackNetwork } from "./network.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

export interface Limits { cpus: number; memBytes: number; pids: number }
export interface LimitSettings { defaults: Record<StackEnv, Limits>; caps: Limits; stack: Record<StackEnv, Limits>; maxServices: number }

const MiB = 1024 * 1024;
/** Decision 6 defaults; the caps are S4-a's choice (recorded in the contract) and come from settings. */
export const DEFAULT_LIMITS: LimitSettings = {
  defaults: {
    live: { cpus: 1.0, memBytes: 768 * MiB, pids: 256 },
    preview: { cpus: 0.5, memBytes: 512 * MiB, pids: 256 },
  },
  caps: { cpus: 2.0, memBytes: 2048 * MiB, pids: 1024 },
  // Second pre-review: limits are per container, so the stack as a whole gets a budget too (sum over services).
  stack: {
    live: { cpus: 2.0, memBytes: 3072 * MiB, pids: 2048 },
    preview: { cpus: 1.0, memBytes: 1536 * MiB, pids: 1024 },
  },
  maxServices: 12,
};
/** Below these a value is "no limit" in practice (Docker rounds tiny CPU and memory values to 0 = unlimited). */
export const MIN_LIMITS: Limits = { cpus: 0.01, memBytes: 6 * MiB, pids: 1 };

const UNIT: Record<string, number> = { "": 1, b: 1 };
for (const [i, u] of ["k", "m", "g", "t"].entries()) { const v = 1024 ** (i + 1); for (const sfx of ["", "b", "i", "ib"]) UNIT[`${u}${sfx}`] = v; }
/** Docker's volume-name rule. A source starting with ".", "/" or "~" is a bind mount to Compose, whatever is declared. */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const unsafe = (where: string, why: string) => new IsolationError("compose_unsafe", `${where}: ${why}`);

/** Settings come from the wizard: a non-positive or non-finite value would mean "unlimited" for every stack. */
export function checkSettings(s: LimitSettings): void {
  if (!Number.isInteger(s?.maxServices) || s.maxServices < 1) throw new IsolationError("limits_missing", "isolation limit settings are invalid");
  for (const l of [s?.defaults?.live, s?.defaults?.preview, s?.caps, s?.stack?.live, s?.stack?.preview]) {
    if (!l || !(l.cpus >= MIN_LIMITS.cpus) || !(l.memBytes >= MIN_LIMITS.memBytes) || !(Number.isInteger(l.pids) && l.pids >= 1) ||
        ![l.cpus, l.memBytes].every(Number.isFinite)) throw new IsolationError("limits_missing", "isolation limit settings are invalid");
  }
}

/** A limit value → a number, undefined when absent, or limits_missing when it is set but does not limit. */
function num(v: unknown, what: string, svc: string, kind: "cpus" | "mem" | "pids"): number | undefined {
  if (v === undefined || v === null) return undefined;
  const bad = () => new IsolationError("limits_missing", `service ${svc}: ${what} does not set a usable limit`);
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const m = kind === "mem" ? v.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)$/) : v.trim().match(/^(\d+(?:\.\d+)?)$/);
    const unit = m ? UNIT[m[2] ?? ""] : undefined;
    if (!m || (kind === "mem" && unit === undefined)) throw bad();
    n = Number(m[1]) * (unit ?? 1);
  } else throw bad();
  if (kind === "mem") n = Math.floor(n);
  // 0 and -1 mean "unlimited" to Compose, and values below the minimum round to 0 in Docker: not limits.
  const min = kind === "cpus" ? MIN_LIMITS.cpus : kind === "mem" ? MIN_LIMITS.memBytes : MIN_LIMITS.pids;
  if (!Number.isFinite(n) || n < min) throw bad();
  if (kind === "pids" && !Number.isInteger(n)) throw bad();
  return n;
}

/** Compose interpolates `$VAR` / `${VAR:-x}` after we checked the value; refuse it where it could matter. */
function noInterpolation(v: unknown, where: string): void {
  // `$$` is Compose's escape for a literal `$` and is never substituted.
  if (typeof v === "string") { if (v.replace(/\$\$/g, "").includes("$")) throw unsafe(where, "uses variable interpolation"); return; }
  if (Array.isArray(v)) { v.forEach((x) => noInterpolation(x, where)); return; }
  if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (k.includes("$")) throw unsafe(where, "uses variable interpolation"); noInterpolation(x, where); }
}

/** A path inside the repo: relative, no `..` escape after normalising, no URL or drive syntax. */
function repoPath(p: unknown, where: string, base: string[] = [], context = false): string[] {
  if (typeof p !== "string" || !p || p.startsWith("/") || p.startsWith("~") || p.includes(":") || p.includes("\\") || p.includes("$")) throw unsafe(where, "path must stay inside the repo");
  const segs = p.split("/").filter((x) => x !== "" && x !== ".");
  // A context whose first segment looks like a host (github.com/…, gitlab.com/…) is a remote Git context to buildx.
  if (context && segs[0] && segs[0] !== ".." && (segs[0].includes(".") || segs[0].startsWith("git@"))) throw unsafe(where, "build context must be a repo directory, not a remote");
  const parts = [...base];
  for (const seg of segs) {
    if (seg === "..") { if (!parts.length) throw unsafe(where, "path must stay inside the repo"); parts.pop(); } else parts.push(seg);
  }
  return parts;
}

// Service keys that cannot reach the host, another project or the limits, with their checks.
const ENV_LIKE = new Set(["environment", "command", "entrypoint", "healthcheck"]);   // interpolation here is the app's own business
const SERVICE_KEYS = new Set([
  "image", "build", "command", "entrypoint", "environment", "working_dir", "user", "expose", "volumes", "tmpfs", "healthcheck",
  "restart", "depends_on", "cpus", "mem_limit", "memswap_limit", "pids_limit", "deploy", "networks", "labels", "hostname",
  "stop_grace_period", "stop_signal", "init", "read_only", "shm_size", "stdin_open", "tty", "platform", "pull_policy",
  "cap_add", "cap_drop", "security_opt", "privileged", "ports", "profiles", "ulimits",
]);
const ULIMITS = new Set(["nofile", "core", "stack", "msgqueue", "sigpending"]);   // not nproc (that is pids) or memlock
const TOP_KEYS = new Set(["services", "networks", "volumes", "version"]);
const BUILD_KEYS = new Set(["context", "dockerfile", "args", "target"]);
const DEPLOY_KEYS = new Set(["resources", "restart_policy", "replicas", "mode"]);

function checkService(name: string, s: Obj, volumes: Obj, where = `service ${name}`): void {
  for (const k of Object.keys(s)) if (!SERVICE_KEYS.has(k) && !k.startsWith("x-")) throw unsafe(where, `option ${k.slice(0, 40)} is not allowed`);
  for (const [k, v] of Object.entries(s)) if (!ENV_LIKE.has(k)) noInterpolation(v, where);
  if (s.privileged !== undefined && s.privileged !== false) throw unsafe(where, "privileged");
  if (s.cap_add !== undefined) {
    if (!Array.isArray(s.cap_add)) throw unsafe(where, "cap_add is not a list");
    for (const c of s.cap_add) if (String(c).toUpperCase().replace(/^CAP_/, "") !== "NET_BIND_SERVICE") throw unsafe(where, "cap_add other than NET_BIND_SERVICE");
  }
  if (s.security_opt !== undefined) {
    if (!Array.isArray(s.security_opt)) throw unsafe(where, "security_opt is not a list");
    for (const o of s.security_opt) if (typeof o !== "string" || !/^no-new-privileges(:true|=true)?$/.test(o)) throw unsafe(where, "security_opt other than no-new-privileges");
  }
  if (s.labels !== undefined) {
    const keys = Array.isArray(s.labels) ? s.labels.map((l: unknown) => String(l).split("=")[0] ?? "") : isObj(s.labels) ? Object.keys(s.labels) : null;
    if (!keys) throw unsafe(where, "labels is not a list or mapping");
    if (keys.some((k: string) => /^(coolify|traefik|caddy|com\.docker)/i.test(k.trim()))) throw unsafe(where, "labels reserved for Coolify, its proxy or Docker");
  }
  if (s.build !== undefined) {
    if (typeof s.build === "string") repoPath(s.build, `${where} build`, [], true);
    else if (isObj(s.build)) {
      for (const k of Object.keys(s.build)) if (!BUILD_KEYS.has(k)) throw unsafe(`${where} build`, `option ${k.slice(0, 40)} is not allowed`);
      const ctx = s.build.context === undefined ? [] : repoPath(s.build.context, `${where} build`, [], true);
      // The Dockerfile path is relative to the context; the result must still be inside the repo.
      if (s.build.dockerfile !== undefined) repoPath(s.build.dockerfile, `${where} build`, ctx);
    } else throw unsafe(where, "build is not a path or mapping");
  }
  if (s.deploy !== undefined) {
    if (!isObj(s.deploy)) throw unsafe(where, "deploy is not a mapping");
    for (const k of Object.keys(s.deploy)) if (!DEPLOY_KEYS.has(k)) throw unsafe(`${where} deploy`, `option ${k.slice(0, 40)} is not allowed`);
    // One container per service: limits are per container, so replicas would multiply the stack's share of the host.
    if (s.deploy.replicas !== undefined && s.deploy.replicas !== 1) throw unsafe(`${where} deploy`, "replicas must be 1");
    if (s.deploy.mode !== undefined && s.deploy.mode !== "replicated") throw unsafe(`${where} deploy`, "mode must be replicated");
    const r = s.deploy.resources;
    if (r !== undefined) {
      if (!isObj(r) || Object.keys(r).some((k) => k !== "limits" && k !== "reservations")) throw unsafe(`${where} deploy`, "resources may hold only limits and reservations");
      for (const part of ["limits", "reservations"]) {
        if (r[part] === undefined) continue;
        if (!isObj(r[part]) || Object.keys(r[part]).some((k) => !["cpus", "memory", "pids"].includes(k))) throw unsafe(`${where} deploy`, `resources.${part} may hold only cpus, memory and pids`);
      }
    }
  }
  if (s.tmpfs !== undefined && !(typeof s.tmpfs === "string" || (Array.isArray(s.tmpfs) && s.tmpfs.every((t: unknown) => typeof t === "string")))) throw unsafe(where, "tmpfs");
  // Volumes: only named volumes declared in this file, and tmpfs. No bind mount of any host path.
  if (s.volumes !== undefined) {
    if (!Array.isArray(s.volumes)) throw unsafe(where, "volumes is not a list");
    for (const v of s.volumes) {
      if (typeof v === "string") {
        const p = v.split(":");
        // An anonymous volume (just a container path) is Docker-managed, not a bind.
        if (p.length === 1 && v.startsWith("/")) continue;
        const src = p[0] ?? "";
        if (!VOLUME_NAME.test(src) || !Object.prototype.hasOwnProperty.call(volumes, src) || p.length > 3) throw unsafe(where, "only named volumes declared in this file can be mounted");
      } else if (isObj(v)) {
        if (Object.keys(v).some((k) => !["type", "source", "target", "read_only", "volume", "tmpfs"].includes(k))) throw unsafe(where, "volume option not allowed");
        if (v.type === "tmpfs") { if (v.source !== undefined) throw unsafe(where, "tmpfs with a source"); continue; }
        if (v.type === "volume" && v.source === undefined && typeof v.target === "string") continue;   // anonymous
        if (v.type !== "volume" || typeof v.source !== "string" || !VOLUME_NAME.test(v.source) || !Object.prototype.hasOwnProperty.call(volumes, v.source)) throw unsafe(where, "only named volumes declared in this file can be mounted");
        if (v.volume !== undefined && (!isObj(v.volume) || Object.keys(v.volume).some((k) => k !== "nocopy"))) throw unsafe(where, "volume option not allowed");
      } else throw unsafe(where, "volume entry is not a string or mapping");
    }
  }
  if (s.profiles !== undefined && !(Array.isArray(s.profiles) && s.profiles.every((x: unknown) => typeof x === "string"))) throw unsafe(where, "profiles is not a list of strings");
  if (s.ulimits !== undefined) {
    if (!isObj(s.ulimits)) throw unsafe(where, "ulimits is not a mapping");
    for (const k of Object.keys(s.ulimits)) if (!ULIMITS.has(k)) throw unsafe(where, `ulimit ${k.slice(0, 20)} is not allowed`);
  }
  // Networks are replaced by the project network; refuse naming Coolify's or an external one so the intent is visible.
  const nets = Array.isArray(s.networks) ? s.networks : isObj(s.networks) ? Object.keys(s.networks) : s.networks === undefined ? [] : null;
  if (!nets) throw unsafe(where, "networks is not a list or mapping");
  for (const n of nets) if (String(n) === "coolify") throw unsafe(where, "attaches the coolify network");
}

function checkTop(doc: Obj): Obj {
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k) && !k.startsWith("x-")) throw unsafe("document", `top-level ${k.slice(0, 40)} is not allowed`);
  if (doc.networks !== undefined) {
    if (!isObj(doc.networks)) throw unsafe("document", "networks is not a mapping");
    for (const [n, d] of Object.entries(doc.networks)) {
      if (n === "coolify" || (isObj(d) && (d.external || d.name !== undefined))) throw unsafe(`network ${n.slice(0, 40)}`, "external or named networks are not allowed");
    }
  }
  const volumes = doc.volumes === undefined ? {} : doc.volumes;
  if (!isObj(volumes)) throw unsafe("document", "volumes is not a mapping");
  for (const [n, d] of Object.entries(volumes)) {
    if (!VOLUME_NAME.test(n)) throw unsafe("document", "volume name must be a plain Docker volume name");
    // A plain local volume only: driver_opts can bind any host path, and name/external can reach another project's data.
    if (d !== null && !(isObj(d) && Object.keys(d).every((k) => k === "driver" || k === "labels") && (d.driver === undefined || d.driver === "local"))) {
      throw unsafe(`volume ${n.slice(0, 40)}`, "only plain local volumes are allowed (no name, external, driver_opts or other driver)");
    }
  }
  return volumes;
}

type Asked = { cpus?: number; memBytes?: number; pids?: number };
/** The limits a service asks for (clamped to the per-service caps), or undefined where it asks for none. */
function askedLimits(name: string, s: Obj, cap: Limits): Asked {
  const lim: Obj = s.deploy?.resources?.limits ?? {};
  const cpus = num(s.cpus, "cpus", name, "cpus") ?? num(lim.cpus, "deploy cpus", name, "cpus");
  const mem = num(s.mem_limit, "mem_limit", name, "mem") ?? num(lim.memory, "deploy memory", name, "mem");
  const pids = num(s.pids_limit, "pids_limit", name, "pids") ?? num(lim.pids, "deploy pids", name, "pids");
  // One source of truth: Compose refuses a service whose deploy limits disagree with the top-level ones.
  if (s.deploy?.resources?.limits) {
    delete s.deploy.resources.limits;
    if (!Object.keys(s.deploy.resources).length) delete s.deploy.resources;
  }
  return {
    cpus: cpus === undefined ? undefined : Math.min(cpus, cap.cpus),
    memBytes: mem === undefined ? undefined : Math.min(mem, cap.memBytes),
    pids: pids === undefined ? undefined : Math.min(pids, cap.pids),
  };
}

/**
 * Fills every unset limit and checks the stack budget (S4-a decision 3). A service without a limit gets the
 * per-env default, lowered to an even share of what the explicit limits leave of the stack budget, so an
 * ordinary app + db + cache stack fits without hand-tuning. Over budget → limits_over_budget.
 */
function fillLimits(asked: Map<string, Asked>, d: Limits, budget: Limits, env: StackEnv): Map<string, Limits> {
  const out = new Map<string, Limits>(); for (const k of asked.keys()) out.set(k, { cpus: 0, memBytes: 0, pids: 0 });
  for (const dim of ["cpus", "memBytes", "pids"] as const) {
    let explicit = 0, unset = 0;
    for (const a of asked.values()) { if (a[dim] === undefined) unset++; else explicit += a[dim]!; }
    const left = budget[dim] - explicit;
    let share = unset ? Math.min(d[dim], left / unset) : 0;
    if (dim !== "cpus") share = Math.floor(share); else share = Math.floor(share * 100) / 100;
    if (left < -1e-9 || (unset && share < MIN_LIMITS[dim])) {
      throw new IsolationError("limits_over_budget", `the stack's services together ask for more ${dim === "memBytes" ? "memory" : dim} than its ${env} budget`);
    }
    for (const [k, a] of asked) out.get(k)![dim] = a[dim] ?? share;
  }
  return out;
}

/**
 * Validates and rewrites a parsed Compose document for one stack. The input must be the parsed document with
 * YAML anchors and merge keys already resolved (a literal `<<` key is refused). Returns a new document (the input
 * is not changed). Throws IsolationError compose_unsafe / limits_missing; nothing is handed on after a throw.
 */
export function hardenCompose(input: unknown, env: StackEnv, net: StackNetwork, settings: LimitSettings = DEFAULT_LIMITS): Obj {
  checkSettings(settings);
  if (!isObj(input)) throw unsafe("document", "the Compose document is not a mapping");
  const doc: Obj = structuredClone(input);
  const volumes = checkTop(doc);
  const services = doc.services;
  if (!isObj(services) || !Object.keys(services).length) throw unsafe("document", "the Compose document has no services");
  const d = settings.defaults[env];
  if (Object.keys(services).length > settings.maxServices) throw unsafe("document", `more than ${settings.maxServices} services`);
  const asked = new Map<string, Asked>();
  for (const [name, raw] of Object.entries(services)) {
    if (!isObj(raw) || name.includes("$") || name.startsWith("<<")) throw unsafe(`service ${name.slice(0, 40)}`, "is not a plain service mapping");
    const s = raw as Obj;
    checkService(name.slice(0, 40), s, volumes);
    asked.set(name, askedLimits(name.slice(0, 40), s, settings.caps));
    s.cap_drop = ["ALL"];
    s.security_opt = ["no-new-privileges:true"];
    delete s.privileged;
    s.networks = [net.name];
    // Published ports come from M2.4-c2 on the Coolify application (one tailnet port per stack); a Compose
    // `ports` entry could bind any host port or interface, so it is dropped, not refused (S4-a decision 4).
    delete s.ports;
  }
  for (const [name, l] of fillLimits(asked, d, settings.stack[env], env)) {
    const s = services[name] as Obj;
    s.cpus = l.cpus; s.mem_limit = l.memBytes; s.memswap_limit = l.memBytes;   // no swap beyond the memory limit
    s.pids_limit = l.pids;
  }
  doc.networks = {
    [net.name]: { name: net.name, driver: "bridge", enable_ipv6: false, ipam: { config: [{ subnet: net.subnet, gateway: net.gateway }] } },
  };
  return doc;
}
