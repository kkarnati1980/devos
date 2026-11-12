// M2.4-b (docs/modules/M2.4.md, decision 8 and its M2.4-b build notes): push the S3 core to the project repo as
// one commit through the Git Data API (blobs → tree → commit → refs/heads/main). No git binary, no credentials on
// disk, never a force-push. Re-run: `main` whose tree equals the core is adopted; `main` with other content is left
// alone and the step fails `name_conflict` (KK decides, M2.4-d raises the card).

import type { GitHubClient } from "./github.js";
import { ProviderError, type Transport } from "./http.js";
import { TEMPLATE_MANIFEST, assertRepoPath, type RepoFile } from "./repo-content.js";
import { StepError, type Found, type StepSpec } from "./runner.js";

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

interface TreeEntry { path: string; mode: string; type: string; sha: string }

const badResponse = (what: string, status?: number): ProviderError =>
  new ProviderError("github", "bad-response", `github ${what} returned an unexpected response`, status);

const sha = (v: unknown, what: string, status?: number): string => {
  if (typeof v !== "string" || !SHA_RE.test(v)) throw badResponse(what, status);
  return v;
};

/** A 409 "Git Repository is empty": GitHub's answer to ref reads and Git Data writes on a repo with no commits. */
const isEmptyRepo = (e: unknown): boolean => e instanceof ProviderError && e.code === "http" && e.status === 409;

export class CoreRepo {
  private readonly base: string;
  constructor(private readonly http: Transport, owner: string, repo: string) {
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new Error("github-name-invalid");
    this.base = `/repos/${owner}/${repo}`;
  }

  /** The commit `main` points at; null when the branch (or any commit) does not exist yet. */
  async mainHead(): Promise<string | null> {
    try {
      const r = await this.http.get<{ object?: { sha?: unknown; type?: unknown } }>(`${this.base}/git/ref/heads/main`);
      if (r.status === 404 || r.body === null) return null;
      if (r.body.object?.type !== "commit") throw badResponse("GET git/ref/heads/main", r.status);
      return sha(r.body.object.sha, "GET git/ref/heads/main", r.status);
    } catch (e) {
      if (isEmptyRepo(e)) return null;
      throw e;
    }
  }

  /** Every blob of a commit's tree, by path. A truncated listing is inconclusive, never "different". */
  async treeOf(commit: string): Promise<Map<string, { mode: string; sha: string }>> {
    const c = await this.http.get<{ tree?: { sha?: unknown } }>(`${this.base}/git/commits/${sha(commit, "commit id")}`);
    if (c.status !== 200 || !c.body) throw badResponse("GET git/commits", c.status);
    const tree = sha(c.body.tree?.sha, "GET git/commits", c.status);
    const t = await this.http.get<{ tree?: unknown; truncated?: unknown }>(`${this.base}/git/trees/${tree}?recursive=1`);
    if (t.status !== 200 || !t.body || !Array.isArray(t.body.tree) || t.body.truncated !== false) throw badResponse("GET git/trees", t.status);
    const out = new Map<string, { mode: string; sha: string }>();
    for (const x of t.body.tree as unknown[]) {
      const e = x as Partial<TreeEntry> | null;
      if (!e || typeof e !== "object" || typeof e.path !== "string" || typeof e.type !== "string" || typeof e.mode !== "string") {
        throw badResponse("GET git/trees", t.status);
      }
      if (e.type === "tree") continue;
      out.set(e.path, { mode: e.mode, sha: sha(e.sha, "GET git/trees", t.status) });
    }
    return out;
  }

  async createBlob(f: RepoFile): Promise<string> {
    const r = await this.http.write<{ sha?: unknown }>("POST", `${this.base}/git/blobs`, { content: f.content.toString("base64"), encoding: "base64" });
    const got = sha(r.body?.sha, "POST git/blobs", r.status);
    if (got !== f.sha) throw badResponse("POST git/blobs (blob id differs from the content hash)", r.status);
    return got;
  }

  async createTree(files: RepoFile[]): Promise<string> {
    const r = await this.http.write<{ sha?: unknown }>("POST", `${this.base}/git/trees`, {
      tree: files.map((f) => ({ path: f.path, mode: f.mode, type: "blob", sha: f.sha })),
    });
    return sha(r.body?.sha, "POST git/trees", r.status);
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const r = await this.http.write<{ sha?: unknown }>("POST", `${this.base}/git/commits`, { message, tree, parents });
    return sha(r.body?.sha, "POST git/commits", r.status);
  }

  async createMain(commit: string): Promise<void> {
    await this.http.write("POST", `${this.base}/git/refs`, { ref: "refs/heads/main", sha: commit });
  }

  /** Fast-forward only (`force: false`): GitHub refuses with 422 if `main` moved. */
  async fastForwardMain(commit: string): Promise<void> {
    await this.http.write("PATCH", `${this.base}/git/refs/heads/main`, { sha: commit, force: false });
  }

  /** Contents API: the first commit on an empty repo (the Git Data API refuses empty repos with 409). */
  async bootstrap(f: RepoFile, message: string): Promise<string> {
    assertRepoPath(f.path);
    const r = await this.http.write<{ commit?: { sha?: unknown } }>("PUT", `${this.base}/contents/${f.path}`, {
      message, content: f.content.toString("base64"), branch: "main",
    });
    return sha(r.body?.commit?.sha, "PUT contents", r.status);
  }
}

type MainState = { kind: "absent" } | { kind: "core"; head: string } | { kind: "bootstrap"; head: string } | { kind: "other"; head: string };

/** Compares `main` with the core: equal tree (paths, modes and blob ids), only the bootstrap file, or other content. */
export async function mainState(repo: CoreRepo, files: RepoFile[]): Promise<MainState> {
  const head = await repo.mainHead();
  if (!head) return { kind: "absent" };
  const tree = await repo.treeOf(head);
  const same = (want: RepoFile[]): boolean =>
    tree.size === want.length && want.every((f) => tree.get(f.path)?.sha === f.sha && tree.get(f.path)?.mode === f.mode);
  if (same(files)) return { kind: "core", head };
  const manifest = files.find((f) => f.path === TEMPLATE_MANIFEST);
  if (manifest && same([manifest])) return { kind: "bootstrap", head };
  return { kind: "other", head };
}

/**
 * The `github/core` step: runs after `github/repo` (which proved the repo is private and carries this project's
 * marker). External id: the commit `main` points at. Journalled but not an inventory row (`inventory: false`):
 * the commit is deleted with the repo.
 */
export function githubCoreStep(gh: GitHubClient, p: { slug: string }, owner: string, files: RepoFile[], version: string): StepSpec {
  if (!files.some((f) => f.path === TEMPLATE_MANIFEST)) throw new Error("template-manifest-missing");
  for (const f of files) assertRepoPath(f.path);
  const repoName = `devos-${p.slug}`;
  const repo = new CoreRepo(gh.http, owner, repoName);
  const name = `${owner}/${repoName}@main`;
  const message = `DevOS: golden-path core ${version}`.replace(/[\r\n]/g, " ").slice(0, 200);
  return {
    key: "github/core",
    provider: "github",
    kind: "core_commit",
    name,
    action: "provision.github.core",
    inventory: false,
    lookup: async () => {
      const s = await mainState(repo, files);
      if (s.kind === "core") return { externalId: s.head, name, owned: true };
      // `other`: never adopted, never overwritten → name_conflict. `bootstrap`: our half-done push, finished by create.
      if (s.kind === "other") return { externalId: s.head, name, owned: false };
      return null;
    },
    create: async (): Promise<Found> => {
      let s = await mainState(repo, files);
      if (s.kind === "core") return { externalId: s.head, name, owned: true };
      if (s.kind === "other") {
        throw new StepError("github/core", "name_conflict", false, true, `${name} already has content that is not the template core`);
      }
      let parent = s.kind === "bootstrap" ? s.head : null;
      let blobsDone = false;
      if (!parent) {
        try {
          for (const f of files) await repo.createBlob(f);
          blobsDone = true;
        } catch (e) {
          if (!isEmptyRepo(e)) throw e;
          // Empty repo: one Contents API commit holding only `.devos/template.json`, then the full core on top.
          parent = await repo.bootstrap(files.find((f) => f.path === TEMPLATE_MANIFEST)!, `${message} (bootstrap)`);
        }
      }
      if (!blobsDone) for (const f of files) await repo.createBlob(f);
      const tree = await repo.createTree(files);
      const commit = await repo.createCommit(message, tree, parent ? [parent] : []);
      if (parent) await repo.fastForwardMain(commit);
      else await repo.createMain(commit);
      s = await mainState(repo, files);
      if (s.kind !== "core" || s.head !== commit) throw badResponse("main after the core push");
      return { externalId: commit, name, owned: true };
    },
  };
}
