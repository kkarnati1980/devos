// DEVOS-236 (M2.5 follow-up, docs/modules/M2.5.md "DEVOS-236 decisions"): the read-only half of the server-side scan
// for orphaned application volumes. Runs inside the deployed API container, started by
// `scripts/server/checks/teardown-orphan-volumes.sh` through
// `docker exec … node deploy/with-db-url.mjs node apps/api/dist/teardown-volumes-cli.js purged-apps`.
// It prints one JSON line, `{"uuids":[…],"live":[…],"invalid":n}`: the Coolify application uuids of `resource` rows a
// purge marked deleted, and (Codex PR209-r12) those of rows not deleted, so the check never reports a live
// application's volume against a purged uuid that is a prefix of the live one. Exit 0 listed, 1 failed, 2 usage, 3 skipped (no database here). It only reads; it never prints a
// secret or a database message (errors are a fixed code).
import { fileURLToPath } from "node:url";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

/** A Coolify application uuid the check can match safely: letters, digits and dashes, 8 to 64 characters. */
export const SCAN_UUID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** At most this many deleted application rows are read (newest first); more is reported, never silently cut. */
export const MAX_ROWS = 2000;
export const USAGE = "teardown-volumes-cli.js purged-apps";

export interface DeletedAppReader {
  /**
   * Coolify application rows, deleted and (Codex PR209-r12) not deleted, read from one snapshot (Codex PR209-r13), so
   * a purge that lands during the read can never leave a row out of both lists.
   */
  applicationIds(limit: number): Promise<{ deleted: string[]; live: string[] }>;
}

/**
 * The CLI's core over an injected reader. Rows whose id cannot be matched safely are counted as `invalid` (never
 * printed), so the check can say the scan is incomplete instead of calling it clean. Duplicates are dropped.
 */
export async function purgedAppsCli(argv: string[], reader: () => Promise<DeletedAppReader>): Promise<CliResult> {
  if (argv.length !== 1 || argv[0] !== "purged-apps") return { code: 2, out: { error: "usage", usage: USAGE } };
  let ids: string[];
  let liveIds: string[];
  try {
    ({ deleted: ids, live: liveIds } = await (await reader()).applicationIds(MAX_ROWS + 1));
  } catch {
    return { code: 1, out: { error: "teardown-volumes-read-failed" } };
  }
  if (!Array.isArray(ids) || !Array.isArray(liveIds)) return { code: 1, out: { error: "teardown-volumes-read-failed" } };
  if (ids.length > MAX_ROWS || liveIds.length > MAX_ROWS) return { code: 1, out: { error: "teardown-volumes-too-many-rows", max: MAX_ROWS } };
  const ok = (id: unknown): id is string => typeof id === "string" && SCAN_UUID_RE.test(id);
  // A live id the check cannot match safely is left out: it can only make the check report more, never hide a leftover.
  const live = [...new Set(liveIds.filter(ok))].sort();
  // A uuid that is both deleted and live (a row still live) is treated as live, so live data is never reported.
  const uuids = [...new Set(ids.filter(ok))].filter((u) => !live.includes(u)).sort();
  const invalid = ids.filter((id) => !ok(id)).length;
  return { code: 0, out: { uuids, live, invalid } };
}

/**
 * The Prisma reader: Coolify `application` rows, deleted (newest deletion first) and not deleted. Both reads run in one
 * REPEATABLE READ transaction, so they see one snapshot (Codex PR209-r13). Read-only.
 */
export function prismaDeletedApps(db: any, timeoutMs: number): DeletedAppReader {
  const ids = (tx: any, status: unknown, limit: number) => tx.resource.findMany({
    where: { provider: "coolify", kind: "application", status },
    select: { externalId: true },
    orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
    take: limit,
  }).then((rows: { externalId: string }[]) => rows.map((r) => r.externalId));
  return {
    applicationIds: (limit) => db.$transaction(
      async (tx: any) => ({ deleted: await ids(tx, "deleted", limit), live: await ids(tx, { not: "deleted" }, limit) }),
      { timeout: timeoutMs, maxWait: timeoutMs, isolationLevel: "RepeatableRead" },
    ),
  };
}

async function main(env: NodeJS.ProcessEnv): Promise<CliResult> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "purged-apps") return { code: 2, out: { error: "usage", usage: USAGE } };
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return { code: 3, out: { code: "skipped", detail: "database-not-configured" } };
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => any };
  const db = createDb(databaseUrl);
  try {
    return await purgedAppsCli(argv, async () => prismaDeletedApps(db, 10_000));
  } finally {
    await db.$disconnect?.().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).then(
    (r) => { process.stdout.write(`${JSON.stringify(r.out)}\n`, () => process.exit(r.code)); },
    () => { process.stdout.write(`${JSON.stringify({ error: "teardown-volumes-error" })}\n`, () => process.exit(1)); },
  );
}
