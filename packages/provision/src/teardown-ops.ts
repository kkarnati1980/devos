// M2.5 teardown operations on M2.4's provider clients (docs/modules/M2.5.md, decisions 3, 4 and 6).
// Added beside M2.4's clients without editing them. Every call goes through the same fixed-origin Transport
// (timeouts, GET retries, no token in any message). A delete is one write; 404/410 means "already gone".

import { ProviderError } from "./http.js";
import type { GitHubClient } from "./github.js";
import type { CoolifyClient } from "./coolify.js";
import { ownershipMarker, type ProviderName } from "./runner.js";

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
      const r = (await gh.http.get<RepoBody>(`/repos/${owner}/${repo}`)).body;
      return r ? { owned: repoOwned(projectId, r) } : null;
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
      const p = await cf.getProject(item.externalId);
      return p ? { owned: (p.description ?? "").includes(ownershipMarker(projectId)) } : null;
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
          if (!x || typeof x.full_name !== "string") throw new ProviderError("github", "bad-response", "github GET /user/repos returned a malformed entry", r.status);
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
        if (!x || typeof x.uuid !== "string" || typeof x.name !== "string") {
          throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/projects returned a malformed project entry", r.status);
        }
        if (x.name === `devos-${p.slug}` || (x.description ?? "").includes(marker)) {
          hits.push({ provider: "coolify", kind: "project", externalId: x.uuid, name: x.name });
        }
      }
      return hits;
    },
  };
}
