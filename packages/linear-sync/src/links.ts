// M2.6-b2b3 (DEVOS-248, docs/modules/M2.6.md "M2.6-b2b3 decisions"): the "Open in Linear" links. DevOS stores only
// Linear ids (the `resource` row of the project, `linear_issue` of each module), so the links are read from Linear by
// those ids when the project page asks: one read, never a write. A link is kept only when Linear returns an https URL
// on linear.app itself; anything else is dropped, so the page never renders a link Linear did not vouch for.

/** The read half of LinearClient this needs (retried reads only). */
export interface LinkReader {
  query<T>(query: string, variables?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<T>;
}

/** Linear's ids are UUIDs; anything else is never sent. */
const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** At most this many issue ids per read (a project's modules; Linear's `in` filter takes a list). */
export const LINK_MAX_ISSUES = 100;

/** An https URL on linear.app (no credentials, no port), normalised; otherwise null. */
export function linearUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.hostname !== "linear.app" || u.port || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface LinearLinks {
  /** The Linear project's URL, or null when none is stored, it is gone, or its URL is not on linear.app. */
  project: string | null;
  /** Issue id → URL, only for ids Linear returned with a linear.app URL. */
  issues: Record<string, string>;
}

/**
 * The URLs of the stored Linear project and issues. Ids that are not UUIDs are skipped (never sent). An unknown
 * project or issue is simply absent; a Linear failure throws (the caller answers with a fixed code).
 */
export async function linearLinks(client: LinkReader, ids: { projectId: string | null; issueIds: readonly string[] }, opts: { signal?: AbortSignal } = {}): Promise<LinearLinks> {
  const call = { signal: opts.signal };
  const projectId = ids.projectId && LINEAR_ID.test(ids.projectId) ? ids.projectId : null;
  const issueIds = [...new Set(ids.issueIds.filter((x) => typeof x === "string" && LINEAR_ID.test(x)))].slice(0, LINK_MAX_ISSUES);
  const out: LinearLinks = { project: null, issues: {} };
  if (projectId) {
    // `project(id)` errors when the id is unknown; the issues read below would still be useful, so a missing project
    // is read through the list filter instead, which answers with an empty list.
    const d = await client.query<{ projects: { nodes: { id: string; url: string }[] } }>(
      `query($id: ID!) { projects(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { id url } } }`, { id: projectId }, call);
    const p = d?.projects?.nodes?.find((n) => n?.id === projectId);
    out.project = p ? linearUrl(p.url) : null;
  }
  if (issueIds.length) {
    const d = await client.query<{ issues: { nodes: { id: string; url: string }[] } }>(
      `query($ids: [ID!]) { issues(filter: { id: { in: $ids } }, first: ${LINK_MAX_ISSUES}, includeArchived: true) { nodes { id url } } }`, { ids: issueIds }, call);
    const wanted = new Set(issueIds);
    for (const n of d?.issues?.nodes ?? []) {
      const url = n && wanted.has(n.id) ? linearUrl(n.url) : null;
      if (url) out.issues[n.id] = url;
    }
  }
  return out;
}
