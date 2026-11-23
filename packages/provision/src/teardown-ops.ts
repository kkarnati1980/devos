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
  /**
   * DEVOS-235 (Codex PR160-r1): set when an earlier purge run began this row's provider delete and did not mark the
   * row deleted (a crash between the DELETE and the inventory update). Absent or null otherwise.
   */
  deleteStartedAt?: Date | null;
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
/** Coolify v4 application states that mean "no container running" (`exited`, `exited:unhealthy`, `stopped`). */
const STOPPED_RE = /^(exited|stopped)(:[a-z]+)?$/;

/**
 * M2.5-a3b (DEVOS-133): Coolify application ops. Owned = the description carries `devos:<project id>` (M2.4-c2's
 * marker). Archive stops the app; there is no un-archive (Restore leaves stacks stopped; the next deploy starts
 * them). Remove deletes the app with its volumes, configuration and connected networks in one call.
 */
export interface AppTeardownOptions {
  /** How long a queued stop or delete may take to show (default 60 s), and the wait between reads (default 2 s). */
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
  const inspect = async (id: string): Promise<{ owned: boolean; status: unknown } | null> => {
    const r = await cf.http.get<{ uuid?: unknown; description?: unknown; status?: unknown }>(`/api/v1/applications/${id}`);
    // Only a 404 proves absence; a 200 must carry this application (same uuid, a string or null description).
    if (r.status === 404) return null;
    const b = r.body;
    if (r.status !== 200 || !b || typeof b !== "object" || b.uuid !== id || !(b.description == null || typeof b.description === "string")) {
      throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/applications/{uuid} returned an inconclusive response (${r.status})`, r.status);
    }
    return { owned: ((b.description as string | null | undefined) ?? "").includes(ownershipMarker(projectId)), status: b.status };
  };
  return {
    provider: "coolify",
    kind: "application",
    inspect: async (item) => {
      const a = await inspect(uuid(item));
      return a && { owned: a.owned };
    },
    archive: async (item) => {
      const id = uuid(item);
      // Stop is idempotent: stopping a stopped app is a no-op at Coolify (a GET, so the transport may retry it).
      const r = await cf.http.get<unknown>(`/api/v1/applications/${id}/stop`);
      // Pre-review 3: an app deleted since Archive's inspect has nothing to stop; confirm with a fresh read.
      if (r.status === 404 && (await inspect(id)) === null) return;
      if (r.status !== 200) {
        throw new ProviderError("coolify", r.status === 404 ? "http" : "bad-response", `coolify stop of an application returned ${r.status}`, r.status);
      }
      // Codex PR154-r3: Coolify only queues the stop ("Stopping request queued."). Archive succeeds (and the repo
      // turns read-only after it) only once a read shows the app stopped (`exited` or `stopped`, with or without a
      // `:health` suffix) or gone; still running when the bound ends, or a status that is not a string, fails
      // the step, so the repo stays writable and Archive can be run again.
      const until = now() + confirmMs;
      for (;;) {
        const a = await inspect(id);
        if (a === null) return;
        if (typeof a.status !== "string") {
          throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/applications/{uuid} returned no status after a stop", 200);
        }
        if (STOPPED_RE.test(a.status)) return;
        if (now() >= until) throw new ProviderError("coolify", "timeout", "coolify has not finished stopping the application yet");
        await sleep(pollMs);
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

/** RFC 7230 §3.2.6 `tchar`. */
const TCHAR = /^[A-Za-z0-9!#$%&'*+.^_`|~-]$/;
/**
 * Codex PR223-r10/r11/r12: a link target is an absolute `http(s)` URI: `scheme://host[:port]` (a reg-name host, a
 * numeric port, no userinfo and no IP-literal brackets), an optional path of pchar and `/`, then an optional `?query`
 * and `#fragment` that add only `?`; every `%` is a valid escape. It must also parse as a WHATWG URL. Anything else
 * (a space, a second `#`, a relative target, `:abc` as a port) is unparseable, whatever its `rel`.
 */
const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const QCHAR = `(?:${PCHAR}|[/?])`;
const HOST = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=]|%[0-9A-Fa-f]{2})+";
const URI_REF = new RegExp(`^https?://${HOST}(?::[0-9]+)?(?:/(?:${PCHAR}|/)*)?(?:\\?${QCHAR}*)?(?:#${QCHAR}*)?$`, "i");
/**
 * RFC 3986 absolute URI, an extension relation type: `scheme ":"`, a non-empty path of pchar and `/`, then an optional
 * `?query` and at most one `#fragment` that add only `/` and `?` (Codex PR223-r19: `urn:x#one#two` is not a URI).
 */
const REL_URI = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:(?:${PCHAR}|/)+(?:\\?${QCHAR}*)?(?:#${QCHAR}*)?$`);
const isLinkTarget = (t: string): boolean => {
  if (!URI_REF.test(t)) return false;
  try { new URL(t); return true; } catch { return false; }
};

/**
 * Codex PR223-r3/r4/r8: GitHub's `Link` response header names a next page (`rel="next"`); a header that cannot be parsed is "malformed". Both the purge scope preflight
 * and the leftover scan read it, so a short page that still has a next page is never taken as the last one.
 */
export function linkNext(headers: { get(name: string): string | null } | undefined, expect?: { origin: string; path: string; query: Readonly<Record<string, string>>; bound?: { last: number | null } }): "next" | "none" | "malformed" {
  const raw = headers?.get("link") ?? "";
  // Codex PR223-r11/r12: with `expect`, every `rel=next` target must be exactly the request the reader makes next:
  // the same origin, the same path and the same query parameters (each once, same value, none extra; so `page` and `per_page` both
  // match), or the header is malformed. A reader that walks pages by counting can then never skip or shift a page.
  const sameRequest = (target: string, query: Readonly<Record<string, string>>): boolean => {
    if (!expect) return true;
    const u = new URL(target);
    // Codex PR223-r13: the same origin too (scheme, host and port), the one the reader's transport is fixed to.
    if (u.origin !== expect.origin || u.pathname !== expect.path) return false;
    const keys = [...u.searchParams.keys()];
    const want = Object.keys(query);
    if (keys.length !== want.length) return false;
    return want.every((k) => { const v = u.searchParams.getAll(k); return v.length === 1 && v[0] === query[k]; });
  };
  const nextOk = (target: string): boolean => sameRequest(target, expect?.query ?? {});
  // Codex PR223-r15: a `rel=last` link says how many pages exist. With `expect` (whose `page` is the page after the
  // one just read), its target must be the same request with a decimal `page` no lower than the current page, or the
  // header is malformed. A last page beyond the current one without a `rel=next` link is a contradiction, and so is a
  // `rel=next` link when the current page is the last one: both are malformed, never read as the end of the listing.
  const current = expect && /^[1-9][0-9]*$/.test(expect.query.page ?? "") ? Number(expect.query.page) - 1 : null;
  // Codex PR223-r16: `bound` carries the last page a reader has been told across its pages, so a later page without
  // a Link header (or with a different last page) can never drop a bound set by an earlier one.
  const prior = expect?.bound?.last ?? null;
  let lastPage: number | null = prior;
  const lastOk = (target: string): boolean => {
    if (!expect) return true;
    if (current === null) return false;
    const pg = new URL(target).searchParams.getAll("page");
    if (pg.length !== 1 || !/^[1-9][0-9]{0,8}$/.test(pg[0] as string)) return false;
    const k = Number(pg[0]);
    if (k < current || !sameRequest(target, { ...expect.query, page: pg[0] as string })) return false;
    if (lastPage !== null && lastPage !== k) return false;
    lastPage = k;
    return true;
  };
  // Codex PR223-r5/r6 (RFC 8288 Appendix B): a small tokenizer, so a `<`, `,` or `;` inside a quoted parameter value
  // never splits a link. Each link is `<uri>` then `;`-separated parameters in any order; `rel` holds a space-separated
  // list of relation types, quoted or not. Any link whose rel list contains `next` counts. A value that cannot be
  // parsed is "malformed" (Codex PR223-r8): the caller treats the whole listing as unreadable, never as complete.
  let i = 0;
  let found = false;
  const n = raw.length;
  const ws = () => { while (i < n && /[\s,]/.test(raw[i] as string)) i++; };
  const sp = () => { while (i < n && /\s/.test(raw[i] as string)) i++; };
  ws();
  while (i < n) {
    if (raw[i] !== "<") return "malformed";
    const close = raw.indexOf(">", i);
    if (close < 0) return "malformed";
    // Codex PR223-r10: the target must be a URI reference (RFC 3986 characters only, every `%` a valid escape);
    // a space, quote or other character outside that set (e.g. `<bad target>`) makes the header malformed.
    const target = raw.slice(i + 1, close);
    if (!isLinkTarget(target)) return "malformed";
    i = close + 1;
    // Codex PR223-r21 (RFC 8288 §3.3: `rel` MUST be present, and once): a link with no `rel`, or with a second
    // `rel`, is malformed, so a target without a relation never reads as "no next page".
    let rels = 0;
    for (;;) {
      sp();
      if (i >= n || raw[i] === ",") { if (rels !== 1) return "malformed"; break; }
      if (raw[i] !== ";") return "malformed";
      i++; sp();
      // Codex PR223-r9: an allow-list grammar. A parameter name, and an unquoted value, is one or more RFC 7230
      // token characters; any other character where one is expected (e.g. `rel=next"`, `re"l=next`, `rel=ne<xt`)
      // makes the header malformed instead of being read as part of the name or value.
      const nameStart = i;
      while (i < n && TCHAR.test(raw[i] as string)) i++;
      const name = raw.slice(nameStart, i).toLowerCase();
      if (i < n && !/[\s=;,]/.test(raw[i] as string)) return "malformed";
      sp();
      let value = "";
      if (raw[i] === "=") {
        i++; sp();
        if (raw[i] === '"') {
          i++;
          let closed = false;
          while (i < n) {
            const c = raw[i++] as string;
            if (c === "\\") { value += raw[i++] ?? ""; continue; }
            if (c === '"') { closed = true; break; }
            value += c;
          }
          if (!closed) return "malformed";
        } else {
          const vs = i;
          while (i < n && TCHAR.test(raw[i] as string)) i++;
          value = raw.slice(vs, i);
          if (value === "" || (i < n && !/[\s;,]/.test(raw[i] as string))) return "malformed";
        }
      }
      // Codex PR223-r7: a parameter without a name, or a `rel` without a value (bare, `rel=` or `rel=""`), is
      // malformed, so it fails closed like any other unparseable header.
      if (name === "") return "malformed";
      // Codex PR223-r22 (RFC 8288 §3.2): an `anchor` parameter moves a link's context to another resource, so its
      // `rel=next`/`rel=last` would no longer describe this listing. GitHub never sends one; any `anchor` is malformed.
      if (name === "anchor") return "malformed";
      if (name === "rel") {
        rels++;
        const types = value.split(/\s+/).filter((t) => t !== "");
        if (types.length === 0) return "malformed";
        // Codex PR223-r14 (RFC 8288 §3.3): each relation type is a registered name (a letter, then letters, digits,
        // `.` or `-`; compared case-insensitively) or an absolute URI; anything else (e.g. `next,`) is malformed.
        // Codex PR223-r18: an extension type is any absolute URI (RFC 3986 `scheme ":" ...`, e.g. `urn:example:x`),
        // not only an http(s) one; it never names a page, so only its syntax is checked.
        if (!types.every((t) => /^[A-Za-z][A-Za-z0-9.-]*$/.test(t) || REL_URI.test(t))) return "malformed";
        if (types.some((t) => t.toLowerCase() === "next")) {
          if (!nextOk(target)) return "malformed";
          found = true;
        }
        if (types.some((t) => t.toLowerCase() === "last") && !lastOk(target)) return "malformed";
      }
    }
    ws();
  }
  if (current !== null && lastPage !== null && (lastPage > current) !== found) return "malformed";
  if (expect?.bound) expect.bound.last = lastPage;
  return found ? "next" : "none";
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
      const bound = { last: null as number | null };
      // Codex PR223-r21: a repository seen twice across pages means the listing shifted, so a repository may have
      // been skipped; the scan is then inconclusive. Repos are keyed by full name (unique, case-insensitive on
      // GitHub) and, when present, by numeric id.
      const seenNames = new Set<string>();
      const seenIds = new Set<number>();
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
          const key = x.full_name.toLowerCase();
          const id = (x as { id?: unknown }).id;
          if (id !== undefined && typeof id !== "number") {
            throw new ProviderError("github", "bad-response", "github GET /user/repos returned a malformed entry", r.status);
          }
          if (seenNames.has(key) || (typeof id === "number" && seenIds.has(id))) {
            throw new ProviderError("github", "bad-response", "github GET /user/repos returned a repository twice", r.status);
          }
          seenNames.add(key);
          if (typeof id === "number") seenIds.add(id);
          if (x.name === `devos-${p.slug}` || (x.description ?? "").includes(marker)) {
            hits.push({ provider: "github", kind: "repo", externalId: x.full_name, name: x.full_name });
          }
        }
        // Codex PR223-r4: as in the scope preflight, a short page is the last one only when no Link rel=next follows.
        const link = linkNext(r.headers, { origin: gh.http.origin, path: "/user/repos", query: { per_page: "100", page: String(page + 1), affiliation: "owner" }, bound });
        if (link === "malformed") throw new ProviderError("github", "bad-response", "github GET /user/repos returned an unreadable Link header", r.status);
        if (link === "next") continue;
        // Codex PR223-r17: a full page is the last one too when a validated rel=last names this page.
        if (r.body.length < 100 || bound.last === page) return hits;
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
        // Codex PR154-r1 (as PR48-r5 for repos): ownership needs the description field present, a string or null.
        // An omitted one is inconclusive, so the scan fails rather than report a renamed application as clean.
        const d = (a as { description?: unknown }).description;
        if (!(d === null || typeof d === "string")) {
          throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/applications returned an application without a description field", 200);
        }
        if (appNames.has(a.name) || (a.description ?? "").includes(marker)) {
          hits.push({ provider: "coolify", kind: "application", externalId: a.uuid, name: a.name });
        }
      }
      return hits;
    },
  };
}

/**
 * DEVOS-21 part 3: the OAuth scopes of a classic token (or an OAuth app token), from GitHub's `X-OAuth-Scopes`
 * response header. `null` when the header is absent or empty: GitHub sends no scopes for a fine-grained token or an
 * app token, so nothing is known about them. Each entry is trimmed; matching is exact, never a prefix.
 */
export function classicScopes(headers: { get(name: string): string | null } | undefined): string[] | null {
  const raw = headers?.get("x-oauth-scopes");
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.split(",").map((x) => x.trim()).filter((x) => x !== "");
}

/**
 * M2.5-a2 purge preflight (M2.5 pre-review finding 2): GitHub answers 404 for a private repo the token cannot see,
 * so a token narrowed to selected repositories could make a repo look gone. The token must see every repo its
 * account owns: the owned-repo listing must hold at least `public_repos + owned_private_repos` from `GET /user`.
 * The token's login must also be `owner` (Codex PR55-r1). Throws `github-token-scope` otherwise (the purge stops
 * with `provider_forbidden`, nothing deleted).
 *
 * DEVOS-21 part 3 (docs/modules/M2.4.md, "AT13 probe failure diagnostics, part 3"): GitHub returns `owned_private_repos` only to a classic
 * token with the `read:user` or `user` scope. A classic token cannot be narrowed to selected repositories at all, so
 * one with the `repo` scope sees every repo its owner owns; that is proof of the same fact. Such a token without
 * the private count field passes when its login is the owner, its owned-repo list reads in full and holds at least
 * `public_repos`. Without the count and without that proof the check still refuses.
 */
export function githubTokenScopeCheck(gh: GitHubClient, opts: { owner: string; maxPages?: number }): () => Promise<void> {
  const maxPages = opts.maxPages ?? 20;
  if (typeof opts?.owner !== "string" || !NAME_RE.test(opts.owner)) throw new Error("github-owner-invalid");
  return async () => {
    const http = await gh.http.pinned();
    const u = await http.get<{ login?: string; public_repos?: number; owned_private_repos?: number }>("/user");
    const pub = u.body?.public_repos; const priv = u.body?.owned_private_repos;
    // Codex PR223-r5: a count is a non-negative safe integer, or the answer is malformed and refused.
    const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (u.status !== 200 || !isCount(pub) || typeof u.body?.login !== "string") {
      throw new Error("github-token-scope: the token cannot read its account's repository counts");
    }
    // Codex PR223-r1: only an absent field (GitHub's public user response) may take the scope proof; a field that is
    // present with any non-number value (null, a string, an object) is a malformed answer and stays refused.
    if (priv !== undefined && !isCount(priv)) {
      throw new Error("github-token-scope: the token cannot read its account's repository counts");
    }
    if (priv === undefined) {
      const scopes = classicScopes(u.headers);
      if (scopes === null) throw new Error("github-token-scope: the token cannot read its account's repository counts");
      if (!scopes.includes("repo")) throw new Error("github-token-scope: the classic token has no repo scope");
    }
    // Codex PR55-r1: the token must belong to the account that owns the project's repos, or its 404s and its owned-
    // repo scan say nothing about them. Checked on the same snapshot the purge uses (pinnedGitHub).
    if (u.body.login.toLowerCase() !== opts.owner.toLowerCase()) {
      throw new Error("github-token-scope: the token belongs to another account than the repository owner");
    }
    let seen = 0;
    let seenPublic = 0;
    let complete = false;
    const ids = new Set<number>();
    // Codex PR223-r23: a repository name (case-insensitive; every entry here is the owner's) is seen once too, so a
    // repository replaced mid-listing (same name, new id) never counts twice and masks an omitted one.
    const names = new Set<string>();
    const bound = { last: null as number | null };
    for (let page = 1; page <= maxPages; page++) {
      const r = await http.get<unknown[]>(`/user/repos?per_page=100&page=${page}&affiliation=owner`);
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error("github-token-scope: the repository list is unreadable");
      // Codex PR223-r2: on the scope proof the list is the only count, so every entry must be an identifiable repo
      // of the owner (a numeric id seen once, a name, owner.login = owner); anything else is an unreadable list.
      // Codex PR223-r18/r19: on the count path every entry is a repo (a numeric id seen once, a name) too, so a
      // repeated entry never makes up for a repository the token does not see; the count itself is the owner's.
      // Codex PR223-r20: an entry that names an owner must name this owner on both paths (only the scope path needs
      // it present); and on the scope path each entry says whether it is private, so public entries are counted alone.
      for (const e of r.body as { id?: unknown; name?: unknown; private?: unknown; owner?: { login?: unknown } }[]) {
        const ownerOk = typeof e?.owner?.login === "string" ? e.owner.login.toLowerCase() === opts.owner.toLowerCase() : priv !== undefined && e?.owner === undefined;
        const ok = e !== null && typeof e === "object" && typeof e.id === "number" && !ids.has(e.id) && typeof e.name === "string" && e.name !== ""
          && !names.has(e.name.toLowerCase()) && ownerOk && (priv !== undefined || typeof e.private === "boolean");
        if (!ok) throw new Error("github-token-scope: the repository list is unreadable");
        ids.add(e.id as number);
        names.add((e.name as string).toLowerCase());
        if (e.private === false) seenPublic++;
      }
      seen += r.body.length;
      // Codex PR223-r3: a short page is the last one only when GitHub's Link header names no next page.
      const link = linkNext(r.headers, { origin: http.origin, path: "/user/repos", query: { per_page: "100", page: String(page + 1), affiliation: "owner" }, bound });
      // Codex PR223-r8: an unparseable Link header makes the whole listing inconclusive.
      if (link === "malformed") throw new Error("github-token-scope: the repository list is unreadable");
      if (link === "next") continue;
      // Codex PR223-r17: a full page is the last one too when a validated rel=last names this page.
      if (r.body.length < 100 || bound.last === page) { complete = true; break; }
    }
    const want = pub + (typeof priv === "number" ? priv : 0);
    // Codex PR223-r16: the list must have been read to its end (no page cap hit) with or without the private count,
    // so a count that is already met never stands in for a page GitHub still advertises.
    if (!complete) throw new Error("github-token-scope: the repository list is unreadable");
    // Codex PR223-r20: on the scope path private entries never stand in for public ones.
    if (priv === undefined && seenPublic < pub) throw new Error(`github-token-scope: the token sees ${seenPublic} of ${pub} public owned repositories; give it access to all repositories`);
    if (seen < want) throw new Error(`github-token-scope: the token sees ${seen} of ${want} owned repositories; give it access to all repositories`);
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
 * Build it, and the purge's Coolify ops and scanner, on one `pinnedCoolify` client, so the proof holds for every call.
 */
export function coolifyTokenScopeCheck(cf: CoolifyClient, recorded: () => Promise<readonly InventoryItem[]>): () => Promise<void> {
  if (typeof recorded !== "function") throw new Error("coolify-recorded-invalid");
  return async () => {
    const rows = (await recorded()).filter((r) => r.provider === "coolify" && r.kind === "project");
    for (const r of rows) {
      if (!COOLIFY_UUID_RE.test(r.externalId)) throw new Error("coolify-token-scope: a recorded Coolify project id is not a uuid");
      const res = await cf.http.get<{ uuid?: string }>(`/api/v1/projects/${r.externalId}`);
      if (res.status === 404) {
        // Codex PR160-r1: an earlier purge run began deleting this project and crashed before marking the row deleted.
        // Its 404 then most likely means "gone", so it proves nothing either way: skip it, as decision 2 does for no
        // row at all. Every other 404 is still read as a wrong-team token.
        if (r.deleteStartedAt) continue;
        throw new Error("coolify-token-scope: the Coolify token cannot see this project's Coolify project; use the token of the team that owns it");
      }
      if (res.status !== 200 || !res.body || typeof res.body !== "object" || res.body.uuid !== r.externalId) {
        throw new Error(`coolify-token-scope: Coolify returned an inconclusive answer for the recorded project (${res.status})`);
      }
    }
  };
}

/**
 * DEVOS-235 pre-review: one Coolify token snapshot for a whole purge, as `pinnedGitHub` does for GitHub. A token
 * swapped in the vault after the preflight (another team's) would answer 404 for every uuid and make the stacks look
 * gone. Build the purge's Coolify ops, scanner and `coolifyTokenScopeCheck` from this one client.
 */
export async function pinnedCoolify(cf: CoolifyClient): Promise<CoolifyClient> {
  const http = await cf.http.pinned();
  const c = Object.create(Object.getPrototypeOf(cf)) as CoolifyClient;
  Object.defineProperty(c, "http", { value: http, enumerable: true });
  return c;
}
