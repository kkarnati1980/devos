// DEVOS-163 (M2.6-b2b1, docs/modules/M2.6.md "M2.6-b2b split and M2.6-b2b1 decisions"): runtime wiring of the
// M2.6-b2a scheduled Linear sync. Off unless DEVOS_LINEAR_SYNC=on (decision 2: mirroring spends Linear capacity on
// KK's plan). The key is read from the vault by name at call time; it never leaves the server and is never logged.
// Pure: the @devos/linear-sync module, the database and the vault are injected; main.ts starts and stops it.

/** The parts of @devos/linear-sync this wiring uses (loaded at run time, like @devos/provision). */
export interface LinearSyncModule {
  LinearClient: new (o: { apiKey: () => Promise<string> }) => unknown;
  graphqlApi(client: any): unknown;
  listActiveProjects(db: any): Promise<string[]>;
  syncActiveProjects(deps: {
    list: () => Promise<string[]>;
    syncOne: (projectId: string) => Promise<"synced" | "skipped" | "inactive">;
    log?: (line: string) => void;
  }): Promise<{ synced: string[]; skipped: string[]; inactive: string[]; failed: { projectId: string; error: string }[] }>;
  lockedSyncOne(db: any, api: any, opts?: { teamKey?: string; log?: (line: string) => void }): (projectId: string) => Promise<"synced" | "skipped" | "inactive">;
  startSchedule(tick: () => Promise<unknown>, opts?: { intervalMs?: number; log?: (line: string) => void }): { stop: () => Promise<void> };
}

export type LinearSyncLog = (e: { level: "info" | "warn"; msg: string; code?: string; projectId?: string; detail?: string; synced?: number; skipped?: number; inactive?: number; failed?: number }) => void;

/** A sync line's length cap (pre-review 1: a line carries ids and at most 40 characters of a DevOS task title). */
export const SYNC_LINE_MAX = 300;

export interface LinearSyncJob {
  start(): void;
  stop(): Promise<void>;
}

const TEAM_KEY = /^[A-Za-z0-9]{1,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key callback every Linear client uses: the vault's `linear_api_key`, by name at call time (never logged). */
export function linearKeyReader(vault: { reveal(name: string): Promise<string | null> }): () => Promise<string> {
  return async () => {
    const key = await vault.reveal("linear_api_key");
    if (!key) throw new Error("linear-key-not-set");
    return key;
  };
}

/**
 * DEVOS-97 follow-up ("shared Linear client" decisions): one `LinearClient` for the sync job, the teardown parts and
 * the links route, so a rate-limit pause one of them sees holds for all three. Null when the sync is off, a piece is
 * missing or the client cannot be built; each builder then reports its own off code as before.
 */
export function sharedLinearClient(w: {
  mod: { LinearClient?: unknown } | null;
  vault: { reveal(name: string): Promise<string | null> } | null;
  env: NodeJS.ProcessEnv;
}): unknown | null {
  if (w.env.DEVOS_LINEAR_SYNC !== "on" || !w.vault || !w.mod || typeof w.mod.LinearClient !== "function") return null;
  try {
    return new (w.mod.LinearClient as new (o: { apiKey: () => Promise<string> }) => unknown)({ apiKey: linearKeyReader(w.vault) });
  } catch {
    return null;
  }
}

/** Decision 2–3: the job, or why it is off (a fixed code, logged by the caller). */
export function buildLinearSync(w: {
  mod: LinearSyncModule | null;
  db: unknown;
  vault: { reveal(name: string): Promise<string | null> } | null;
  env: NodeJS.ProcessEnv;
  log: LinearSyncLog;
  intervalMs?: number;
  /** The shared client (`sharedLinearClient`); absent → the job builds its own. */
  client?: unknown;
}): LinearSyncJob | { off: string } {
  if (w.env.DEVOS_LINEAR_SYNC !== "on") return { off: "linear-sync-disabled" };
  if (!w.db) return { off: "linear-sync-no-database" };
  if (!w.vault) return { off: "linear-sync-vault-not-configured" };
  if (!w.mod) return { off: "linear-sync-not-loaded" };
  // Pre-review r2: every export this wiring calls must be a function, or the sync is off (the API still starts).
  const EXPORTS = ["LinearClient", "graphqlApi", "listActiveProjects", "syncActiveProjects", "lockedSyncOne", "startSchedule"] as const;
  if (EXPORTS.some((k) => typeof (w.mod as unknown as Record<string, unknown>)[k] !== "function")) return { off: "linear-sync-not-loaded" };
  const teamKey = w.env.DEVOS_LINEAR_TEAM_KEY ?? "DEVOS";
  if (!TEAM_KEY.test(teamKey)) return { off: "linear-team-key-invalid" };
  const mod = w.mod;
  const vault = w.vault;
  const db = w.db;
  // Pre-review 1: the sync's divergence and inbound lines (fixed text, ids and at most 40 characters of a DevOS task
  // title, never Linear or provider error text) are logged as structured events, capped in length (AT6 "and logged").
  const LINE = /^linear-sync: project ([0-9a-f-]{36})(?: inbound)?: /i;
  const syncLog = (line: string) => {
    const m = LINE.exec(line);
    w.log({ level: "info", msg: /^linear-sync: project [0-9a-f-]{36} inbound: /i.test(line) ? "linear-sync-inbound" : "linear-sync-divergence", projectId: m && UUID.test(m[1]!) ? m[1] : undefined, detail: (m ? line.slice(m[0].length) : line).slice(0, SYNC_LINE_MAX) });
  };
  let syncOne: ReturnType<LinearSyncModule["lockedSyncOne"]>;
  try {
    const client = w.client ?? new mod.LinearClient({ apiKey: linearKeyReader(vault) });
    syncOne = mod.lockedSyncOne(db, mod.graphqlApi(client), { teamKey, log: syncLog });
  } catch {
    // Pre-review: a module that loaded without the expected exports turns the sync off; the API still starts.
    return { off: "linear-sync-not-loaded" };
  }
  const tick = async () => {
    // Pre-review 4: no key → one warning per tick, not one per project (and no lock or transaction is opened).
    // Pre-review r2: a vault that cannot read the key is named as such, not as a missing key.
    const key = await vault.reveal("linear_api_key").then((k) => (k ? "set" : "not-set"), () => "unreadable");
    if (key !== "set") {
      w.log({ level: "warn", msg: "linear-sync-skipped", code: key === "unreadable" ? "linear-key-unreadable" : "linear-key-not-set" });
      return;
    }
    const r = await mod.syncActiveProjects({ list: () => mod.listActiveProjects(db), syncOne });
    for (const f of r.failed) w.log({ level: "warn", msg: "linear-sync-project-failed", code: "linear-sync-failed", projectId: UUID.test(f.projectId) ? f.projectId : undefined });
    w.log({ level: "info", msg: "linear-sync-swept", synced: r.synced.length, skipped: r.skipped.length, inactive: r.inactive.length, failed: r.failed.length });
  };
  let schedule: { stop: () => Promise<void> } | null = null;
  return {
    start() {
      if (schedule) return;
      schedule = mod.startSchedule(tick, {
        ...(w.intervalMs ? { intervalMs: w.intervalMs } : {}),
        log: () => w.log({ level: "warn", msg: "linear-sync-tick-failed", code: "linear-sync-tick-failed" }),
      });
      w.log({ level: "info", msg: "linear-sync-started" });
    },
    async stop() {
      const s = schedule;
      schedule = null;
      if (s) await s.stop();
    },
  };
}

// DEVOS-247 (M2.6-b2b2, AT7, docs/modules/M2.6.md "M2.6-b2b2 decisions"): the Linear part of every teardown
// (archive → Linear project completed, restore → started, purge → archived in Linear and its rows marked deleted,
// plus the `linear` leftover scanner). On only when the sync is on (decision 1), with the same key, team and module.

/** The parts of @devos/linear-sync the teardown uses. */
export interface LinearTeardownModule {
  LinearClient: new (o: { apiKey: () => Promise<string> }) => unknown;
  graphqlApi(client: any): unknown;
  linearTeardownOps(db: any, api: any, projectId: string, makeError: LinearMakeError): { provider: string; kind: string }[];
  linearScanner(api: any, teamKey: string, makeError: LinearMakeError): { name: string };
}
export type LinearMakeError = (code: "network" | "timeout" | "http" | "bad-response" | "no-token", message: string, status?: number) => Error;
export type LinearTeardownParts = (projectId: string) => { ops: { provider: string; kind: string }[]; scanners: { name: string }[] };

/**
 * The per-project Linear ops and scanner, or why there are none (a fixed code). `providerError` builds
 * `@devos/provision`'s ProviderError, so @devos/teardown treats a Linear timeout or 5xx as retryable.
 */
export function buildLinearTeardown(w: {
  mod: Partial<LinearTeardownModule> | null;
  db: unknown;
  vault: { reveal(name: string): Promise<string | null> } | null;
  env: NodeJS.ProcessEnv;
  providerError: ((provider: string, code: string, message: string, status?: number) => Error) | null;
  /** The shared client (`sharedLinearClient`); absent → the parts build their own. */
  client?: unknown;
}): LinearTeardownParts | { off: string } {
  if (w.env.DEVOS_LINEAR_SYNC !== "on") return { off: "linear-sync-disabled" };
  if (!w.db) return { off: "linear-sync-no-database" };
  if (!w.vault) return { off: "linear-sync-vault-not-configured" };
  const mod = w.mod;
  const EXPORTS = ["LinearClient", "graphqlApi", "linearTeardownOps", "linearScanner"] as const;
  if (!mod || EXPORTS.some((k) => typeof (mod as Record<string, unknown>)[k] !== "function") || !w.providerError) return { off: "linear-sync-not-loaded" };
  const teamKey = w.env.DEVOS_LINEAR_TEAM_KEY ?? "DEVOS";
  if (!TEAM_KEY.test(teamKey)) return { off: "linear-team-key-invalid" };
  const m = mod as LinearTeardownModule;
  const vault = w.vault;
  const db = w.db;
  const pe = w.providerError;
  const makeError: LinearMakeError = (code, message, status) => pe("linear", code, message, status);
  let api: unknown;
  try {
    api = m.graphqlApi(w.client ?? new m.LinearClient({ apiKey: linearKeyReader(vault) }));
  } catch {
    return { off: "linear-sync-not-loaded" };
  }
  return (projectId) => ({ ops: m.linearTeardownOps(db, api, projectId, makeError), scanners: [m.linearScanner(api, teamKey, makeError)] });
}
