// M2.6-b2b2 (DEVOS-247, AT7, docs/modules/M2.6.md "M2.6-b2b2 decisions"): the Linear side of M2.5's teardown.
// Archive marks the project's Linear project completed, Restore marks it started again, and Purge archives it in
// Linear (never deletes it); the purge then marks its `resource` rows deleted (G2 evidence). Every Linear write runs
// under the same per-project advisory lock as the sync (`devos:linear-sync`), so a sync that is mid-run never
// interleaves with it. Shaped as `@devos/provision` ResourceOps / LeftoverScanner (structurally; no dependency).
import { LinearError } from "./client.js";
import { readMarker } from "./markers.js";
import { WRITE_MARGIN_MS, type PrismaLike } from "./prisma-store.js";
import type { LinearTeardownApi } from "./types.js";

/** The provider error codes `@devos/teardown` understands (`@devos/provision` ProviderError). */
export type TeardownErrorCode = "network" | "timeout" | "http" | "bad-response" | "no-token";
/** Builds the caller's provider error (in production `new ProviderError("linear", code, message, status)`). */
export type MakeError = (code: TeardownErrorCode, message: string, status?: number) => Error;

export interface LinearInventoryItem { provider: string; kind: string; externalId: string; name: string }
export interface LinearResourceOps {
  provider: "linear";
  kind: "project" | "milestone";
  inspect(item: LinearInventoryItem): Promise<{ owned: boolean } | null>;
  remove(item: LinearInventoryItem): Promise<void>;
  archive?(item: LinearInventoryItem): Promise<void>;
  unarchive?(item: LinearInventoryItem): Promise<void>;
}

/** Longest a teardown write waits for a running sync to release the project's lock. */
export const TEARDOWN_LOCK_WAIT_MS = 60_000;
/** The lock transaction's bound: the wait, then at least WRITE_MARGIN_MS left for the one write (guarded). */
export const TEARDOWN_LOCK_TX_MS = 120_000;

/**
 * Maps any failure to the caller's provider error with a fixed message (Linear's own error text is never passed on:
 * it ends up in cards and logs). Network, timeout, 5xx and 429 stay transient, so the teardown retries them.
 */
export function toProviderError(e: unknown, makeError: MakeError, what: string): Error {
  if (e instanceof LinearError) {
    switch (e.code) {
      case "network": return makeError("network", `linear ${what}: network error`);
      case "timeout": return makeError("timeout", `linear ${what}: timed out`);
      case "rate-limited": return makeError("http", `linear ${what}: rate limited`, 429);
      case "http": return makeError("http", `linear ${what}: HTTP ${e.status ?? "error"}`, e.status);
      default: return makeError("bad-response", `linear ${what}: refused or unexpected response`);
    }
  }
  if (e instanceof Error && e.message === "linear-key-not-set") return makeError("no-token", `linear ${what}: the Linear key is not set`);
  if (e instanceof Error && e.message === "linear-sync-lock-busy") return makeError("timeout", `linear ${what}: a Linear sync still holds the project's lock`);
  return makeError("bad-response", `linear ${what}: unexpected error`);
}

/**
 * Runs `fn` while holding the project's sync lock. Unlike the sync (which skips a held lock), a teardown write waits
 * for it, at most TEARDOWN_LOCK_WAIT_MS (Postgres `lock_timeout` covers advisory locks); a lock still held after that
 * is `linear-sync-lock-busy`, which the caller maps to a retryable timeout. The transaction only holds the lock.
 */
export async function withSyncLock<T>(db: PrismaLike, projectId: string, fn: (guard: () => Promise<void>) => Promise<T>,
                                      o: { waitMs?: number; txMs?: number; now?: () => number } = {}): Promise<T> {
  const waitMs = o.waitMs ?? TEARDOWN_LOCK_WAIT_MS;
  const txMs = o.txMs ?? TEARDOWN_LOCK_TX_MS;
  const now = o.now ?? Date.now;
  if (!Number.isInteger(waitMs) || waitMs < 1 || txMs <= waitMs) throw new Error("linear-sync: teardown lock bounds are invalid");
  return db.$transaction(async (tx: any) => {
    const deadline = now() + txMs;
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${waitMs}`);
    try {
      // Wrapped so the row has a typed column: the pg adapter cannot read pg_advisory_xact_lock's void result.
      await tx.$queryRawUnsafe(`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('devos:linear-sync'), hashtext($1))) AS l`, projectId);
    } catch (e) {
      // Pre-review 1: only a lock timeout (SQLSTATE 55P03) means "a sync still holds it"; anything else is a real error.
      if (isLockTimeout(e)) throw new Error("linear-sync-lock-busy");
      throw e;
    }
    // Pre-review r2 (fencing, as the sync's LockGuard): the write starts only while the lock is held and will still be
    // held when the write's own timeout ends; otherwise it is "busy" (retryable) and nothing is written.
    const guard = async () => {
      if (deadline - now() < WRITE_MARGIN_MS) throw new Error("linear-sync-lock-busy");
      try { await tx.$queryRawUnsafe("SELECT 1"); } catch { throw new Error("linear-sync-lock-busy"); }
      if (deadline - now() < WRITE_MARGIN_MS) throw new Error("linear-sync-lock-busy");
    };
    return fn(guard);
  }, { timeout: txMs, maxWait: 10_000 });
}

/** Postgres `lock_not_available` (55P03), however the driver or Prisma wraps it. */
export function isLockTimeout(e: unknown): boolean {
  for (let x: any = e, i = 0; x && i < 4; x = x.cause, i++) {
    if (x.code === "55P03" || x.meta?.code === "55P03" || x.originalCode === "55P03") return true;
    if (typeof x.message === "string" && /canceling statement due to lock timeout/i.test(x.message)) return true;
  }
  return false;
}

/**
 * The teardown ops for one DevOS project's Linear rows (provider `linear`).
 * - `project`: proven ours by its marker (`devos-ref: project/<id>`) and by the row's name (the DevOS project id).
 *   Archive → status completed; Restore → status started; Purge → archived in Linear. A Linear project that is
 *   already archived or gone counts as removed, so a re-run after a crash does not write again.
 * - `milestone`: a milestone is archived with its project and has no Linear write of its own; its row is marked
 *   deleted by the purge (inspect answers "nothing left to remove").
 */
export function linearTeardownOps(db: PrismaLike, api: LinearTeardownApi, projectId: string, makeError: MakeError): LinearResourceOps[] {
  const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { throw toProviderError(e, makeError, what); }
  };
  // One Linear write inside the lock, right after the guard; any read it needs (the status id) runs before the lock.
  const locked = (what: string, write: () => Promise<void>) => call(what, () => withSyncLock(db, projectId, async (guard) => { await guard(); await write(); }));
  const setStatus = async (what: string, id: string, type: "completed" | "started") => {
    const statusId = await call(what, () => api.projectStatusId(type));
    await locked(what, () => api.updateProjectStatus(id, statusId));
  };
  const project: LinearResourceOps = {
    provider: "linear",
    kind: "project",
    async inspect(item) {
      const p = await call("project lookup", () => api.projectState(item.externalId));
      if (!p || p.archivedAt) return null;
      return { owned: item.name === projectId && readMarker(p.description, "project") === projectId };
    },
    archive: (item) => setStatus("project complete", item.externalId, "completed"),
    unarchive: (item) => setStatus("project restart", item.externalId, "started"),
    remove: (item) => locked("project archive", () => api.archiveProject(item.externalId)),
  };
  const milestone: LinearResourceOps = {
    provider: "linear",
    kind: "milestone",
    inspect: async () => null,
    remove: async () => { throw makeError("bad-response", "linear milestone: no delete of its own (archived with its project)"); },
  };
  return [project, milestone];
}

/**
 * The independent leftover check for Linear (M2.5 decision 6): every Linear project in the team that carries this
 * project's marker (archived ones included, every page) is a hit unless it is archived. A failed read is an error (fixed text), never "clean".
 */
export function linearScanner(api: LinearTeardownApi, teamKey: string, makeError: MakeError): { name: "linear"; scan(p: { id: string; slug: string }): Promise<{ provider: string; kind: string; externalId: string; name: string }[]> } {
  return {
    name: "linear",
    async scan(p) {
      let found: Awaited<ReturnType<LinearTeardownApi["findProjects"]>>;
      try {
        found = await api.findProjects(await api.teamId(teamKey), p.id);
      } catch (e) {
        throw toProviderError(e, makeError, "leftover scan");
      }
      // Pre-review 2: every project carrying the marker counts, not only the first one.
      return found.filter((x) => !x.archivedAt).map((x) => ({ provider: "linear", kind: "project", externalId: x.id, name: p.id }));
    },
  };
}
