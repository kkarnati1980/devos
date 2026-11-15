// M2.5 teardown operations on M2.4's provider clients (docs/modules/M2.5.md, decisions 3, 4 and 6).
// Added beside M2.4's clients without editing them. Every call goes through the same fixed-origin Transport
// (timeouts, GET retries, no token in any message). A delete is one write; 404/410 means "already gone".

import { ProviderError } from "./http.js";
import type { GitHubClient } from "./github.js";
import type { CoolifyClient } from "./coolify.js";
import { ownershipMarker, type ProviderName } from "./runner.js";
import { applicationName, listApplications } from "./application.js";
import { STACK_ENVS } from "./stack.js";

/** One inventory row as teardown sees it. */
export interface InventoryItem {
  provider: ProviderName;
  kind: string;
  externalId: string;
  name: string;
}

/** What teardown can do to one kind of resource. `inspect` returns null when the resource is gone. */
export interface ResourceOps {
  provider: ProviderName;
  kind: string;
  inspect(item: InventoryItem): Promise<{ owned: boolean } | null>;
  /** Exactly one delete call. Resolves when the provider confirms or says it is already gone (404/410). */
  remove(item: InventoryItem): Promise<void>;
  /** Archive (reversible stop) and its undo, where the provider has one. */
  archive?(item: InventoryItem): Promise<void>;
  unarchive?(item: InventoryItem): Promise<void>;
}

/** One thing the leftover scan found. */
export interface LeftoverHit {
  provider: string;
  kind: string;
  externalId: string;
  name: string;
}

export interface LeftoverScanner {
  readonly name: string;
  scan(project: { id: string; slug: string }): Promise<LeftoverHit[]>;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function splitRepo(fullName: string): [string, string] {
  const [owner, repo, extra] = fullName.split("/");
  if (extra !== undefined || !owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new Error("github-name-invalid");
  return [owner, repo];
}

/** 404 and 410 on a delete mean the resource is already gone (decision 4). */
const gone = (e: unknown): boolean => e instanceof ProviderError && e.code === "http" && (e.status === 404 || e.status === 410);

interface RepoBody {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  archived?: boolean;
}

const repoOwned = (projectId: string, r: RepoBody): boolean =>
  r.private === true && (r.description ?? "").trim().endsWith(ownershipMarker(projectId));

/** GitHub repo ops: owned = private and the description ends with `devos:<project id>` (decision 3). */
export function githubRepoOps(gh: GitHubClient, projectId: string): ResourceOps {
  return {
    provider: "github",
    kind: "repo",
    inspect: async (item) => {
      const [owner, repo] = splitRepo(item.externalId);
      const r = await gh.http.get<RepoBody>(`/repos/${owner}/${repo}`);
      // Codex PR48-r1: only a 404 proves absence; a 200 must carry a repo object. Anything else is inconclusive.
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body || typeof r.body !== "object" || typeof r.body.full_name !== "string") {
        throw new ProviderError("github", "bad-response", `github GET /repos/{owner}/{repo} returned an inconclusive response (${r.status})`, r.status);
      }
      return { owned: repoOwned(projectId, r.body) };
    },
    remove: async (item) => {
      const [owner, repo] = splitRepo(item.externalId);
      try {
        await gh.http.write("DELETE", `/repos/${owner}/${repo}`);
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
    archive: async (item) => {
      const [owner, repo] = splitRepo(item.externalId);
      await gh.http.write("PATCH", `/repos/${owner}/${repo}`, { archived: true });
    },
    unarchive: async (item) => {
      const [owner, repo] = splitRepo(item.externalId);
      await gh.http.write("PATCH", `/repos/${owner}/${repo}`, { archived: false });
    },
  };
}

/** Coolify project ops: owned = the description carries `devos:<project id>`. */
export function coolifyProjectOps(cf: CoolifyClient, projectId: string): ResourceOps {
  return {
    provider: "coolify",
    kind: "project",
    inspect: async (item) => {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(item.externalId)) throw new Error("coolify-uuid-invalid");
      const r = await cf.http.get<{ uuid?: string; description?: string | null }>(`/api/v1/projects/${item.externalId}`);
      // Codex PR48-r1: only a 404 proves absence; a 200 must carry the project object.
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body || typeof r.body !== "object" || typeof r.body.uuid !== "string") {
        throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/projects/{uuid} returned an inconclusive response (${r.status})`, r.status);
      }
      return { owned: (r.body.description ?? "").includes(ownershipMarker(projectId)) };
    },
    remove: async (item) => {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(item.externalId)) throw new Error("coolify-uuid-invalid");
      try {
        await cf.http.write("DELETE", `/api/v1/projects/${item.externalId}`);
      } catch (e) {
        if (!gone(e)) throw e;
      }
    },
  };
}

const APP_UUID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * M2.5-a3b (DEVOS-133): Coolify application ops. Owned = the description carries `devos:<project id>` (M2.4-c2's
 * marker). Archive stops the app; there is no un-archive (Restore leaves stacks stopped; the next deploy starts
 * them). Remove deletes the app with its volumes, configuration and connected networks in one call.
 */
export interface AppTeardownOptions {
  /** How long a queued delete may take to show as gone (default 60 s), and the wait between reads (default 2 s). */
  confirmMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function coolifyApplicationOps(cf: CoolifyClient, projectId: string, o: AppTeardownOptions = {}): ResourceOps {
  const confirmMs = o.confirmMs ?? 60_000;
  const pollMs = o.pollMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const uuid = (item: InventoryItem): string => {
    if (!APP_UUID_RE.test(item.externalId)) throw new Error("coolify-uuid-invalid");
    return item.externalId;
  };
  const inspect = async (id: string): Promise<{ owned: boolean } | null> => {
    const r = await cf.http.get<{ uuid?: unknown; description?: unknown }>(`/api/v1/applications/${id}`);
    // Only a 404 proves absence; a 200 must carry this application (same uuid, a string or null description).
    if (r.status === 404) return null;
    const b = r.body;
    if (r.status !== 200 || !b || typeof b !== "object" || b.uuid !== id || !(b.description == null || typeof b.description === "string")) {
      throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/applications/{uuid} returned an inconclusive response (${r.status})`, r.status);
    }
    return { owned: ((b.description as string | null | undefined) ?? "").includes(ownershipMarker(projectId)) };
  };
  return {
    provider: "coolify",
    kind: "application",
    inspect: async (item) => inspect(uuid(item)),
    archive: async (item) => {
      const id = uuid(item);
      // Stop is idempotent: stopping a stopped app is a no-op at Coolify (a GET, so the transport may retry it).
      const r = await cf.http.get<unknown>(`/api/v1/applications/${id}/stop`);
      // Pre-review 3: an app deleted since Archive's inspect has nothing to stop; confirm with a fresh read.
      if (r.status === 404 && (await inspect(id)) === null) return;
      if (r.status !== 200) {
        throw new ProviderError("coolify", r.status === 404 ? "http" : "bad-response", `coolify stop of an application returned ${r.status}`, r.status);
      }
    },
    remove: async (item) => {
      const id = uuid(item);
      const q = "delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true";
      try {
        await cf.http.write("DELETE", `/api/v1/applications/${id}?${q}`);
      } catch (e) {
        if (!gone(e)) throw e;
      }
      // Pre-review 1: Coolify only queues the delete. The row is marked deleted (and the environment after it is
      // touched) only once a read shows the app gone; otherwise a transient error makes the purge stop as
      // `delete_unconfirmed` (retryable, no second delete in this run).
      const until = now() + confirmMs;
      for (;;) {
        if ((await inspect(id)) === null) return;
        if (now() >= until) throw new ProviderError("coolify", "timeout", "coolify has not finished deleting the application yet");
        await sleep(pollMs);
      }
    },
  };
}

/**
 * GitHub leftover scan (decision 6): every repo of the token's account named `devos-<slug>` or whose description
 * carries the project's marker. Independent of the inventory. Pages are bounded (`maxPages` × 100 repos); a full
 * last page means the scan could not see everything, which is reported as a hit so it is never read as "clean".
 */
export function githubScanner(gh: GitHubClient, opts: { maxPages?: number } = {}): LeftoverScanner {
  const maxPages = opts.maxPages ?? 20;
  return {
    name: "github",
    scan: async (p) => {
      if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
      const marker = ownershipMarker(p.id);
      const hits: LeftoverHit[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const r = await gh.http.get<RepoBody[]>(`/user/repos?per_page=100&page=${page}&affiliation=owner`);
        if (r.status !== 200 || !Array.isArray(r.body)) {
          throw new ProviderError("github", "bad-response", `github GET /user/repos returned an unexpected response (${r.status})`, r.status);
        }
        for (const x of r.body) {
          // Codex PR48-r4: every field the match reads must be well-formed, or the whole scan is inconclusive.
          // Codex PR48-r5: the field must be present (string or null); an omitted description is inconclusive.
          const okDesc = x && (x.description === null || typeof x.description === "string");
          if (!x || typeof x.full_name !== "string" || typeof x.name !== "string" || !okDesc || x.full_name.split("/")[1] !== x.name) {
            throw new ProviderError("github", "bad-response", "github GET /user/repos returned a malformed entry", r.status);
          }
          if (x.name === `devos-${p.slug}` || (x.description ?? "").includes(marker)) {
            hits.push({ provider: "github", kind: "repo", externalId: x.full_name, name: x.full_name });
          }
        }
        if (r.body.length < 100) return hits;
      }
      hits.push({ provider: "github", kind: "scan-incomplete", externalId: "", name: `more than ${maxPages * 100} repos; scan not complete` });
      return hits;
    },
  };
}

/** Coolify leftover scan: projects named `devos-<slug>` or carrying the marker. */
export function coolifyScanner(cf: CoolifyClient): LeftoverScanner {
  return {
    name: "coolify",
    scan: async (p) => {
      if (!SLUG_RE.test(p.slug)) throw new Error("slug-invalid");
      const marker = ownershipMarker(p.id);
      const r = await cf.http.get<{ uuid: string; name: string; description?: string | null }[]>("/api/v1/projects");
      if (r.status !== 200 || !Array.isArray(r.body)) {
        throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/projects returned an unexpected response (${r.status})`, r.status);
      }
      const hits: LeftoverHit[] = [];
      for (const x of r.body) {
        if (!x || typeof x.uuid !== "string" || typeof x.name !== "string" || !(x.description === null || typeof x.description === "string")) {
          throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/projects returned a malformed project entry", r.status);
        }
        if (x.name === `devos-${p.slug}` || (x.description ?? "").includes(marker)) {
          hits.push({ provider: "coolify", kind: "project", externalId: x.uuid, name: x.name });
        }
      }
      // M2.5-a3b: applications too (M2.4-c2 names them `devos-<slug>-preview|live` and marks the description).
      const appNames = new Set(STACK_ENVS.map((env) => applicationName(p.slug, env)));
      for (const a of await listApplications(cf)) {
        if (appNames.has(a.name) || (a.description ?? "").includes(marker)) {
          hits.push({ provider: "coolify", kind: "application", externalId: a.uuid, name: a.name });
        }
      }
      return hits;
    },
  };
}

/**
 * M2.5-a2 purge preflight (M2.5 pre-review finding 2): GitHub answers 404 for a private repo the token cannot see,
 * so a token narrowed to selected repositories could make a repo look gone. The token must see every repo its
 * account owns: the owned-repo listing must hold at least `public_repos + owned_private_repos` from `GET /user`.
 * The token's login must also be `owner` (Codex PR55-r1). Throws `github-token-scope` otherwise (the purge stops
 * with `provider_forbidden`, nothing deleted).
 */
export function githubTokenScopeCheck(gh: GitHubClient, opts: { owner: string; maxPages?: number }): () => Promise<void> {
  const maxPages = opts.maxPages ?? 20;
  if (typeof opts?.owner !== "string" || !NAME_RE.test(opts.owner)) throw new Error("github-owner-invalid");
  return async () => {
    const http = await gh.http.pinned();
    const u = await http.get<{ login?: string; public_repos?: number; owned_private_repos?: number }>("/user");
    const pub = u.body?.public_repos; const priv = u.body?.owned_private_repos;
    if (u.status !== 200 || typeof pub !== "number" || typeof priv !== "number" || typeof u.body?.login !== "string") {
      throw new Error("github-token-scope: the token cannot read its account's repository counts");
    }
    // Codex PR55-r1: the token must belong to the account that owns the project's repos, or its 404s and its owned-
    // repo scan say nothing about them. Checked on the same snapshot the purge uses (pinnedGitHub).
    if (u.body.login.toLowerCase() !== opts.owner.toLowerCase()) {
      throw new Error("github-token-scope: the token belongs to another account than the repository owner");
    }
    let seen = 0;
    for (let page = 1; page <= maxPages; page++) {
      const r = await http.get<unknown[]>(`/user/repos?per_page=100&page=${page}&affiliation=owner`);
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error("github-token-scope: the repository list is unreadable");
      seen += r.body.length;
      if (r.body.length < 100) break;
    }
    if (seen < pub + priv) throw new Error(`github-token-scope: the token sees ${seen} of ${pub + priv} owned repositories; give it access to all repositories`);
  };
}

/**
 * Codex pre-review (M2.5-a2): one GitHub token snapshot for a whole purge. Returns a client whose every call (the
 * scope preflight, inspect, delete and the leftover scan) uses the token read now, so a token narrowed in the vault
 * after the preflight can never make a repo it cannot see look gone. Build the purge's GitHub ops and scanner from it.
 */
export async function pinnedGitHub(gh: GitHubClient): Promise<GitHubClient> {
  const http = await gh.http.pinned();
  const c = Object.create(Object.getPrototypeOf(gh)) as GitHubClient;
  Object.defineProperty(c, "http", { value: http, enumerable: true });
  return c;
}

const COOLIFY_UUID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * DEVOS-235 purge preflight: Coolify answers 404 for a uuid outside the token's team, so a token for the wrong team
 * would make every Coolify project, environment and application look gone and blind the leftover scan. Before any
 * delete, the token must read each of the project's still-active Coolify project rows: a 200 that carries the same
 * uuid. A 404 (or any other answer) throws `coolify-token-scope`, so the purge stops with `provider_forbidden` and
 * deletes nothing. A 5xx or timeout stays a transient ProviderError (the purge stops retryable). With no active
 * Coolify project row there is nothing recorded to prove (docs/modules/M2.5.md, "DEVOS-235 decisions" 2).
 */
export function coolifyTokenScopeCheck(cf: CoolifyClient, recorded: () => Promise<readonly InventoryItem[]>): () => Promise<void> {
  if (typeof recorded !== "function") throw new Error("coolify-recorded-invalid");
  return async () => {
    const rows = (await recorded()).filter((r) => r.provider === "coolify" && r.kind === "project");
    for (const r of rows) {
      if (!COOLIFY_UUID_RE.test(r.externalId)) throw new Error("coolify-token-scope: a recorded Coolify project id is not a uuid");
      const res = await cf.http.get<{ uuid?: string }>(`/api/v1/projects/${r.externalId}`);
      if (res.status === 404) {
        throw new Error("coolify-token-scope: the Coolify token cannot see this project's Coolify project; use the token of the team that owns it");
      }
      if (res.status !== 200 || !res.body || typeof res.body !== "object" || res.body.uuid !== r.externalId) {
        throw new Error(`coolify-token-scope: Coolify returned an inconclusive answer for the recorded project (${res.status})`);
      }
    }
  };
}
