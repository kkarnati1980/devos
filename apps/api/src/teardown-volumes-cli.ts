// DEVOS-236 (M2.5 follow-up, docs/modules/M2.5.md "DEVOS-236 decisions"): the read-only half of the server-side scan
// for orphaned application volumes. Runs inside the deployed API container, started by
// `scripts/server/checks/teardown-orphan-volumes.sh` through
// `docker exec … node deploy/with-db-url.mjs node apps/api/dist/teardown-volumes-cli.js purged-apps`.
// It prints one JSON line, `{"uuids":[…],"invalid":n}`: the Coolify application uuids of `resource` rows a purge
// marked deleted. Exit 0 listed, 1 failed, 2 usage, 3 skipped (no database here). It only reads; it never prints a
// secret or a database message (errors are a fixed code).
import { fileURLToPath } from "node:url";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

/** A Coolify application uuid the check can match safely: letters, digits and dashes, 8 to 64 characters. */
export const SCAN_UUID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** At most this many deleted application rows are read (newest first); more is reported, never silently cut. */
export const MAX_ROWS = 2000;
export const USAGE = "teardown-volumes-cli.js purged-apps";

export interface DeletedAppReader { deletedApplicationIds(limit: number): Promise<string[]> }

/**
 * The CLI's core over an injected reader. Rows whose id cannot be matched safely are counted as `invalid` (never
 * printed), so the check can say the scan is incomplete instead of calling it clean. Duplicates are dropped.
 */
export async function purgedAppsCli(argv: string[], reader: () => Promise<DeletedAppReader>): Promise<CliResult> {
  if (argv.length !== 1 || argv[0] !== "purged-apps") return { code: 2, out: { error: "usage", usage: USAGE } };
  let ids: string[];
  try {
    ids = await (await reader()).deletedApplicationIds(MAX_ROWS + 1);
  } catch {
    return { code: 1, out: { error: "teardown-volumes-read-failed" } };
  }
  if (ids.length > MAX_ROWS) return { code: 1, out: { error: "teardown-volumes-too-many-rows", max: MAX_ROWS } };
  const uuids = [...new Set(ids.filter((id) => typeof id === "string" && SCAN_UUID_RE.test(id)))].sort();
  const invalid = ids.filter((id) => !(typeof id === "string" && SCAN_UUID_RE.test(id))).length;
  return { code: 0, out: { uuids, invalid } };
}

/** The Prisma reader: Coolify `application` rows with status `deleted`, newest deletion first. Read-only. */
export function prismaDeletedApps(db: any, timeoutMs: number): DeletedAppReader {
  return {
    async deletedApplicationIds(limit) {
      const rows = await db.$transaction(
        (tx: any) => tx.resource.findMany({
          where: { provider: "coolify", kind: "application", status: "deleted" },
          select: { externalId: true },
          orderBy: [{ deletedAt: "desc" }, { id: "asc" }],
          take: limit,
        }),
        { timeout: timeoutMs, maxWait: timeoutMs },
      );
      return rows.map((r: { externalId: string }) => r.externalId);
    },
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
