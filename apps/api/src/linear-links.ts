// M2.6-b2b3 (DEVOS-248, docs/modules/M2.6.md "M2.6-b2b3 decisions"): the project page's "Open in Linear" links.
// GET /projects/by-slug/:slug/linear-links reads the stored Linear ids (the project's active `resource` row of
// provider linear/kind project, and each module's `linear_issue`) and asks Linear for their URLs, read-only. It is on
// only with the sync (DEVOS_LINEAR_SYNC=on); off, it answers `enabled: false` and makes no Linear call. Only
// https://linear.app URLs leave the API; a Linear failure answers a fixed code, never Linear's text. Behind the global
// session check like every other route (GET never writes).
import { Controller, Get, Inject, Param } from "@nestjs/common";
import { httpError } from "./auth.js";

export const LINEAR_LINKS = Symbol("devos:linear-links");
const SLUG = /^[a-z0-9-]{2,40}$/;
const TEAM_OFF = "linear-sync-disabled";
/** A Linear read is retried by the client; the route gives up after this and answers `linear-unreachable`. */
export const LINEAR_LINKS_TIMEOUT_MS = 15_000;

export interface LinearIdsRow {
  linearProjectId: string | null;
  modules: { key: string; linearIssue: string | null }[];
}

export interface LinearLinksService {
  /** The stored ids of the project with this slug, or null when there is no such project. */
  ids(slug: string): Promise<LinearIdsRow | null>;
  /** Linear's URLs for those ids (only https://linear.app ones), read-only. */
  links(ids: { projectId: string | null; issueIds: string[] }): Promise<{ project: string | null; issues: Record<string, string> }>;
}

export interface LinearLinksView {
  enabled: boolean;
  project: string | null;
  modules: { key: string; url: string }[];
}

const LINEAR_URL = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "linear.app" && !u.port && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};

/** The view: a module gets a link only when it has a stored id and Linear returned a linear.app URL for it. */
export function linksView(row: LinearIdsRow, got: { project: string | null; issues: Record<string, string> }): LinearLinksView {
  const modules: { key: string; url: string }[] = [];
  for (const m of row.modules) {
    if (!m.linearIssue || !Object.hasOwn(got.issues, m.linearIssue)) continue;
    const url = LINEAR_URL(got.issues[m.linearIssue]);
    if (url) modules.push({ key: String(m.key).slice(0, 40), url });
  }
  return { enabled: true, project: row.linearProjectId ? LINEAR_URL(got.project) : null, modules };
}

@Controller("projects")
export class LinearLinksController {
  constructor(@Inject(LINEAR_LINKS) private readonly svc: LinearLinksService | null) {}

  static timeoutMs = LINEAR_LINKS_TIMEOUT_MS;

  @Get("by-slug/:slug/linear-links")
  async get(@Param("slug") slug: string): Promise<LinearLinksView> {
    if (!SLUG.test(slug)) throw httpError(400, "slug-invalid");
    if (!this.svc) return { enabled: false, project: null, modules: [] };
    let row: LinearIdsRow | null;
    try {
      row = await this.svc.ids(slug);
    } catch {
      throw httpError(503, "linear-links-store-failed");
    }
    if (!row) throw httpError(404, "project-not-found");
    const issueIds = row.modules.map((m) => m.linearIssue).filter((x): x is string => typeof x === "string" && x.length > 0);
    if (!row.linearProjectId && issueIds.length === 0) return { enabled: true, project: null, modules: [] };
    let t: NodeJS.Timeout | undefined;
    try {
      const got = await Promise.race([
        this.svc.links({ projectId: row.linearProjectId, issueIds }),
        new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("timeout")), LinearLinksController.timeoutMs); }),
      ]);
      return linksView(row, got);
    } catch {
      throw httpError(502, "linear-unreachable");
    } finally {
      clearTimeout(t);
    }
  }
}

export interface LinearLinksModule {
  LinearClient: new (o: { apiKey: () => Promise<string> }) => { query<T>(q: string, v?: Record<string, unknown>): Promise<T> };
  linearLinks: (client: unknown, ids: { projectId: string | null; issueIds: readonly string[] }) => Promise<{ project: string | null; issues: Record<string, string> }>;
}

type Db = {
  project: { findUnique(a: unknown): Promise<{ id: string } | null> };
  resource: { findFirst(a: unknown): Promise<{ externalId: string } | null> };
  module: { findMany(a: unknown): Promise<{ key: string; linearIssue: string | null }[]> };
};

/** The service, or why it is off (a fixed code). On only with the sync, the database, the vault and the module. */
export function buildLinearLinks(w: {
  mod: Partial<LinearLinksModule> | null;
  db: unknown;
  vault: { reveal(name: string): Promise<string | null> } | null;
  env: NodeJS.ProcessEnv;
}): LinearLinksService | { off: string } {
  if (w.env.DEVOS_LINEAR_SYNC !== "on") return { off: TEAM_OFF };
  if (!w.db) return { off: "linear-sync-no-database" };
  if (!w.vault) return { off: "linear-sync-vault-not-configured" };
  const mod = w.mod;
  if (!mod || typeof mod.LinearClient !== "function" || typeof mod.linearLinks !== "function") return { off: "linear-sync-not-loaded" };
  const vault = w.vault;
  const db = w.db as Db;
  let client: unknown;
  try {
    client = new mod.LinearClient({
      apiKey: async () => {
        const key = await vault.reveal("linear_api_key");
        if (!key) throw new Error("linear-key-not-set");
        return key;
      },
    });
  } catch {
    return { off: "linear-sync-not-loaded" };
  }
  const linearLinks = mod.linearLinks;
  return {
    async ids(slug) {
      const p = await db.project.findUnique({ where: { slug }, select: { id: true } });
      if (!p) return null;
      const [res, modules] = await Promise.all([
        db.resource.findFirst({ where: { projectId: p.id, provider: "linear", kind: "project", status: "active" }, orderBy: { createdAt: "desc" }, select: { externalId: true } }),
        db.module.findMany({ where: { projectId: p.id }, orderBy: { key: "asc" }, select: { key: true, linearIssue: true }, take: 500 }),
      ]);
      return { linearProjectId: res?.externalId ?? null, modules };
    },
    links: (ids) => linearLinks(client, ids),
  };
}
