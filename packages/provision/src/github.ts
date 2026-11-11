// M2.4-a GitHub client: only the calls the provisioner needs (docs/modules/M2.4.md, decisions 2, 3 and 8).
// Ownership marker: the repo description ends with `devos:<project id>`, set in the create call itself,
// so a repo is never left half-tagged.

import { Transport, type TransportOptions } from "./http.js";
import { ownershipMarker, type Found, type StepSpec } from "./runner.js";

export const GITHUB_ORIGIN = "https://api.github.com";
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

interface RepoBody {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
}

export type GitHubOptions = Omit<TransportOptions, "provider" | "origin" | "authHeader" | "extraHeaders"> & { origin?: string };

export class GitHubClient {
  readonly http: Transport;
  constructor(opts: GitHubOptions) {
    this.http = new Transport({
      provider: "github",
      origin: opts.origin ?? GITHUB_ORIGIN,
      timeoutMs: 15_000,
      ...opts,
      authHeader: (t) => ({ authorization: `Bearer ${t}` }),
      extraHeaders: { "x-github-api-version": "2022-11-28", "user-agent": "devos-provisioner" },
    });
  }

  async findRepo(owner: string, name: string): Promise<RepoBody | null> {
    if (!NAME_RE.test(owner) || !NAME_RE.test(name)) throw new Error("github-name-invalid");
    const r = await this.http.get<RepoBody>(`/repos/${owner}/${name}`);
    return r.body;
  }

  /** The token's own login: `POST /user/repos` always creates under it. Read once per client. */
  private login?: Promise<string>;
  whoami(): Promise<string> {
    this.login ??= this.http.get<{ login: string }>("/user").then((r) => {
      if (!r.body || typeof r.body.login !== "string") throw new Error("github-user-unknown");
      return r.body.login;
    });
    this.login.catch(() => { this.login = undefined; });
    return this.login;
  }

  /** `POST /user/repos`: a private, empty repo (no auto-init) for the token's own account. */
  async createRepo(name: string, description: string): Promise<RepoBody> {
    if (!NAME_RE.test(name)) throw new Error("github-name-invalid");
    const r = await this.http.write<RepoBody>("POST", "/user/repos", { name, description, private: true, auto_init: false, has_wiki: false });
    return r.body;
  }
}

const toFound = (projectId: string, r: RepoBody): Found => ({
  externalId: r.full_name,
  name: r.full_name,
  owned: r.private === true && (r.description ?? "").trim().endsWith(ownershipMarker(projectId)),
});

/** The project repo step: `<owner>/devos-<slug>`, private, carrying the ownership marker. */
export function githubRepoStep(gh: GitHubClient, p: { id: string; slug: string; name: string }, owner: string): StepSpec {
  const repo = `devos-${p.slug}`;
  const label = p.name.replace(/[\r\n\t]/g, " ").slice(0, 200);
  return {
    key: "github/repo",
    provider: "github",
    kind: "repo",
    name: `${owner}/${repo}`,
    action: "provision.github.repo",
    lookup: async () => {
      const r = await gh.findRepo(owner, repo);
      return r ? toFound(p.id, r) : null;
    },
    create: async () => {
      // Check the owner before creating, so a mismatch can never leave an orphan repo on the token's account.
      const login = await gh.whoami();
      if (login.toLowerCase() !== owner.toLowerCase()) throw new Error("github-owner-mismatch: the token's account is not the configured owner");
      const r = await gh.createRepo(repo, `${label} (DevOS project) ${ownershipMarker(p.id)}`);
      if (r.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error("github-repo-owner-mismatch");
      return toFound(p.id, r);
    },
  };
}
