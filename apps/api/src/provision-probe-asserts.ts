// DEVOS-234 (M2.4-d3c-2b, docs/modules/M2.4.md "M2.4-d3c-2b decisions"): AT13's live asserts against the real GitHub
// and Coolify, over the probe's recorded ids only (its `done` journal rows). Read-only: GET calls only, each bounded by
// the provider transport's timeout. Every failure is a fixed code; a provider body or message is never returned.

/** The provider transport's read, as `@devos/provision` exposes it (`Transport.get`). */
export interface ReadHttp {
  get<T>(path: string): Promise<{ status: number; body: T | null }>;
}

/** The `@devos/provision` exports the asserts use, read structurally (the package is loaded at run time). */
export interface AssertModule {
  pinnedGitHub(gh: unknown): Promise<{ http: ReadHttp }>;
  pinnedCoolify(cf: unknown): Promise<{ http: ReadHttp }>;
  CoreRepo: new (http: ReadHttp, owner: string, repo: string) => {
    treeOf(commit: string): Promise<Map<string, { mode: string; sha: string }>>;
    blobContent(id: string): Promise<Buffer>;
  };
  STACK_ENVS: readonly string[];
  APP_SECRET_NAMES: readonly string[];
  ownershipMarker(projectId: string): string;
  parseCompose(buf: Buffer): unknown;
}

/**
 * Decision 2: Coolify keeps a description in a 255-character column (Laravel `string`); a longer one is cut or refused
 * depending on the release, so the stored one must fit and still carry the marker.
 */
export const COOLIFY_DESCRIPTION_MAX = 255;
/** Decision 5: the CLI prints a detail of at most 120 characters (`safeDetail`), so the list is capped to fit. */
export const ASSERT_DETAIL_MAX = 120;

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const dotsOnly = (s: string) => /^\.+$/.test(s);

/** The probe's `done` journal rows, step key → external id; one bounded read (ADR-0011 §9). */
export async function readProbeSteps(db: any, projectId: string, timeoutMs: number): Promise<Map<string, string>> {
  const rows = (await db.$transaction(
    (tx: any) => tx.provisionStep.findMany({ where: { projectId, status: "done" }, select: { key: true, externalId: true } }),
    { timeout: timeoutMs, maxWait: timeoutMs },
  )) as { key: unknown; externalId: unknown }[];
  const m = new Map<string, string>();
  for (const r of rows) if (typeof r.key === "string" && typeof r.externalId === "string" && r.externalId) m.set(r.key, r.externalId);
  return m;
}

/** Key order is irrelevant to a YAML mapping, so two documents compare by their sorted-key JSON. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Decision 3: the stored Compose equals the committed file when it is the same text, the same base64 (a release that
 * keeps the create body as sent), or the same YAML document (a release that re-serializes it). Anything else differs.
 */
export function composeMatches(stored: unknown, committed: Buffer, parse: (b: Buffer) => unknown): boolean {
  if (typeof stored !== "string" || stored === "") return false;
  if (stored === committed.toString("utf8") || stored === committed.toString("base64")) return true;
  try {
    return canonical(parse(Buffer.from(stored, "utf8"))) === canonical(parse(committed));
  } catch {
    return false;
  }
}

/**
 * Decision 4: an env var is runtime-only when no build-time flag is set and no runtime flag is cleared. Coolify v4
 * releases name the flags `is_build_time`, or `is_buildtime` / `is_runtime`; an entry with none of them cannot be
 * confirmed, so it fails closed (`unknown`).
 */
export function envPhase(e: Record<string, unknown>): "runtime" | "build" | "unknown" {
  const flags = ["is_build_time", "is_buildtime", "is_runtime"].filter((k) => typeof e[k] === "boolean");
  if (flags.length === 0) return "unknown";
  return e.is_build_time === true || e.is_buildtime === true || e.is_runtime === false ? "build" : "runtime";
}

/** Decision 5: sorted, without repeats, and cut to fit the printed detail with a `more-<n>` count. */
export function capCodes(codes: string[]): string[] {
  const all = [...new Set(codes)].sort();
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const rest = all.length - i - 1;
    const tail = rest > 0 ? `,more-${rest}` : "";
    if ([...out, all[i]].join(",").length + tail.length > ASSERT_DETAIL_MAX) {
      out.push(`more-${all.length - i}`);
      return out;
    }
    out.push(all[i]!);
  }
  return out;
}

export interface AssertDeps {
  mod: AssertModule;
  gh: unknown;
  cf: unknown;
  projectId: string;
  steps(): Promise<Map<string, string>>;
}

/**
 * AT13's live asserts (decision 6 of the d3c-2 decisions). Returns the failure codes, empty when every assert passes.
 * One check's read failure is its own `*-unreadable` code, so the other checks still run; a missing journal row is
 * `journal-missing:<key>`. Only the reads that build the inputs (pinning, the journal) may throw.
 */
export async function probeLiveAsserts(d: AssertDeps): Promise<string[]> {
  const steps = await d.steps();
  const gh = (await d.mod.pinnedGitHub(d.gh)).http;
  const cf = (await d.mod.pinnedCoolify(d.cf)).http;
  const marker = d.mod.ownershipMarker(d.projectId);
  const codes: string[] = [];
  const need = (key: string, re: RegExp): string | null => {
    const v = steps.get(key);
    if (v && re.test(v)) return v;
    codes.push(`journal-missing:${key}`);
    return null;
  };

  // GitHub: the recorded repo's default branch.
  const full = need("github/repo", /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/);
  const [owner, repoName] = full ? (full.split("/") as [string, string]) : ["", ""];
  const repoOk = !!full && NAME_RE.test(owner) && NAME_RE.test(repoName) && !dotsOnly(owner) && !dotsOnly(repoName);
  if (full && !repoOk) codes.push("journal-missing:github/repo");
  if (repoOk) {
    try {
      const r = await gh.get<{ default_branch?: unknown }>(`/repos/${owner}/${repoName}`);
      if (r.status !== 200 || !r.body) codes.push("default-branch-unreadable");
      else if (r.body.default_branch !== "main") codes.push("default-branch-not-main");
    } catch {
      codes.push("default-branch-unreadable");
    }
  }
  const commit = need("github/deploy_compose", SHA_RE);
  // The journalled commit's tree, read once for both environments; a failed read stays failed (never "no file").
  let tree: Promise<Map<string, { mode: string; sha: string }>> | null = null;
  const repo = repoOk ? new d.mod.CoreRepo(gh, owner, repoName) : null;

  for (const env of d.mod.STACK_ENVS) {
    const uuid = need(`coolify/application/${env}`, UUID_RE);
    if (!uuid) continue;
    // The stored application: description and Compose.
    let app: { description?: unknown; docker_compose_raw?: unknown } | null = null;
    try {
      const r = await cf.get<{ description?: unknown; docker_compose_raw?: unknown }>(`/api/v1/applications/${uuid}`);
      app = r.status === 200 && r.body && typeof r.body === "object" ? r.body : null;
    } catch {
      app = null;
    }
    if (!app) codes.push(`app-unreadable:${env}`);
    else {
      const desc = app.description;
      if (typeof desc !== "string" || !desc.includes(marker)) codes.push(`app-description-marker:${env}`);
      if (typeof desc === "string" && desc.length > COOLIFY_DESCRIPTION_MAX) codes.push(`app-description-length:${env}`);
      if (repo && commit) {
        try {
          tree ??= repo.treeOf(commit);
          const entry = (await tree).get(`deploy/compose.${env}.devos.yaml`);
          if (!entry) codes.push(`app-compose-differs:${env}`);
          else if (!composeMatches(app.docker_compose_raw, await repo.blobContent(entry.sha), d.mod.parseCompose)) codes.push(`app-compose-differs:${env}`);
        } catch {
          codes.push(`compose-unreadable:${env}`);
        }
      }
    }
    // The app secrets' env vars: listed, readable, runtime-only.
    let envs: Record<string, unknown>[] | null = null;
    try {
      const r = await cf.get<unknown>(`/api/v1/applications/${uuid}/envs`);
      envs = r.status === 200 && Array.isArray(r.body) ? (r.body as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : null;
    } catch {
      envs = null;
    }
    if (!envs) {
      codes.push(`env-unreadable:${env}`);
      continue;
    }
    for (const key of d.mod.APP_SECRET_NAMES) {
      const e = envs.find((x) => x.key === key && x.is_preview !== true);
      if (!e || typeof e.value !== "string" || e.value === "") {
        codes.push(`env-not-readable:${env}/${key}`);
        continue;
      }
      const phase = envPhase(e);
      if (phase === "build") codes.push(`env-build-time:${env}/${key}`);
      else if (phase === "unknown") codes.push(`env-build-time-unknown:${env}/${key}`);
    }
  }
  return capCodes(codes);
}
