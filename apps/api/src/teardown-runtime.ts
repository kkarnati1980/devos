// DEVOS-244 (M2.5-b1, docs/modules/M2.5.md "M2.5-b1 decisions"): the production wiring behind the archive and
// restore routes. Every action is built from teardownWiring (one pinned GitHub and one pinned Coolify client per
// call), PrismaTeardownStore with the provisioning advisory lock, and the M1.7 engine deciding for KK's own session
// (never `allowAll`). Off, with a code, when the modules, the vault or the provisioning settings are missing.
import type { KkSession } from "./auth.js";
import type { LinearTeardownParts } from "./linear-sync-runtime.js";
import { provisionConfig, vaultToken, type ProvisionModule } from "./provision-runtime.js";
import { teardownWiring, type ProvisionTeardownModule, type TeardownModule, type TeardownStoreLike } from "./teardown-wiring.js";
import { PROVISIONER_IDENTITY } from "./provision-runtime.js";
import { teardownResource } from "./teardown-wiring.js";
import { TeardownSweepJob, type PurgeCardLike, type TeardownSweepDeps } from "./teardown-sweep.js";
import type { ScanReportLike, TeardownActions, TeardownProjectRow, TeardownReader, TeardownServices } from "./teardown-routes.js";

type Authorize = (action: string, resource: string) => Promise<"allow" | "deny" | "require_approval">;

/** What `@devos/teardown` exports that the routes use (loaded at run time, like @devos/provision). */
export interface TeardownRuntimeModule extends TeardownModule {
  restoreProject(projectId: string, o: Record<string, unknown>): Promise<void>;
  PrismaTeardownStore: new (db: unknown, o: Record<string, unknown>) => TeardownStoreLike & {
    withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
    assertLockHeld(projectId: string): Promise<void>;
    project(id: string): Promise<{ id: string; slug: string; stage: string; archivedAt: Date | null; purgeAfter: Date | null } | null>;
    lastScan(id: string): Promise<ScanReportLike | null>;
    activeResources(id: string): Promise<readonly { provider: string; kind: string }[]>;
  };
}

export interface TeardownPolicy {
  decide(r: { identity: { id: string; type: "kk" }; action: { type: string; resource: string; projectId: string } }): Promise<{ enforcedOutcome: string }>;
}

/** M1.7 for KK's own request: `teardown.archive` / `teardown.restore` on `project:<id>`, as KK's session identity. */
export function kkAuthorizer(policy: TeardownPolicy, session: KkSession, projectId: string): Authorize {
  return async (action, resource) => {
    const d = await policy.decide({ identity: session.identity, action: { type: action, resource, projectId } });
    return d.enforcedOutcome === "allow" ? "allow" : d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

/** Reads behind GET /projects/{id}/teardown; every call bounded (ADR-0011 §9). */
export class PrismaTeardownReader implements TeardownReader {
  constructor(
    private readonly db: any,
    private readonly store: InstanceType<TeardownRuntimeModule["PrismaTeardownStore"]>,
    private readonly timeoutMs: number,
  ) {}

  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }

  private row(p: { id: string; slug: string; stage: unknown; archivedAt: Date | null; purgeAfter: Date | null } | null): TeardownProjectRow | null {
    return p ? { id: p.id, slug: p.slug, stage: String(p.stage), archivedAt: p.archivedAt ?? null, purgeAfter: p.purgeAfter ?? null } : null;
  }

  async project(id: string) {
    return this.row(await this.store.project(id));
  }

  async projectBySlug(slug: string) {
    return this.row(await this.tx((tx) => tx.project.findUnique({ where: { slug }, select: { id: true, slug: true, stage: true, archivedAt: true, purgeAfter: true } })));
  }

  async activeResources(projectId: string): Promise<{ provider: string; kind: string }[]> {
    const rows = (await this.store.activeResources(projectId)) as readonly { provider: unknown; kind: unknown }[];
    return rows.map((r) => ({ provider: String(r.provider), kind: String(r.kind) }));
  }

  lastScan(projectId: string) {
    return this.store.lastScan(projectId);
  }

  async archiveDays(): Promise<number> {
    const s: { archiveDays: number } | null = await this.tx((tx) => tx.appSettings.findFirst({ where: { singleton: true }, select: { archiveDays: true } }));
    return s?.archiveDays ?? 30;
  }
}

export function buildTeardownServices(w: {
  mod: ProvisionModule | null;
  td: TeardownRuntimeModule | null;
  db: unknown;
  databaseUrl: string;
  vault: { reveal(name: string): Promise<string | null> } | null;
  policy: TeardownPolicy;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** DEVOS-247: the Linear teardown parts (null when the Linear sync is off). */
  linear?: LinearTeardownParts | null;
}): TeardownServices | { off: string } {
  if (!w.mod || !w.td) return { off: "teardown-not-loaded" };
  if (!w.vault) return { off: "teardown-vault-not-configured" };
  const cfg = provisionConfig(w.env);
  if ("off" in cfg) return { off: cfg.off };
  // A route waits at most 10 s for the project lock: a provisioning or purge run holding it answers 409 project-busy.
  const store = new w.td.PrismaTeardownStore(w.db, { databaseUrl: w.databaseUrl, dbTimeoutMs: w.timeoutMs, lockWaitMs: 10_000 });
  const pm = w.mod as unknown as ProvisionTeardownModule;
  const td = w.td;
  const gh = new w.mod.GitHubClient({ token: vaultToken(w.vault as never, "github_token") });
  const cf = new w.mod.CoolifyClient({ origin: cfg.coolifyOrigin, token: vaultToken(w.vault as never, "coolify_api_token") });
  const ops = async (projectId: string) =>
    (await teardownWiring(pm, td, { gh, cf, store, db: w.db, projectId, owner: cfg.owner, timeoutMs: w.timeoutMs, linear: w.linear ?? null })).ops;
  const actions: TeardownActions = {
    archive: async (session, projectId, windowDays) =>
      td.archiveProject(projectId, { store, authorize: kkAuthorizer(w.policy, session, projectId), ops: await ops(projectId), windowDays }) as Promise<{ archivedAt: Date; purgeAfter: Date }>,
    restore: async (session, projectId) =>
      td.restoreProject(projectId, { store, authorize: kkAuthorizer(w.policy, session, projectId), ops: await ops(projectId) }),
  };
  return { reader: new PrismaTeardownReader(w.db, store, w.timeoutMs), actions };
}


// DEVOS-245 (M2.5-b2, "M2.5-b2 decisions"): the production wiring of the purge card and the teardown jobs. A purge
// runs only under the grant of an approved purge card (grantAuthorizer: the provisioner identity presenting KK's
// grant to M1.7), on teardownWiring's pinned clients, scanners and preflight list. Every read is bounded.

/**
 * M2.5-b2 rule 4 (pre-review r2 1 and 2): the purge's authorizer. Only `teardown.purge`; refused when the card is older
 * than the project's `archived_at` (re-read when purgeProject asks, which is under the project lock, so a Restore and a
 * new Archive in between are seen); and "allow" only when M1.7 allowed **by using this grant**, so every attempt spends
 * a use whatever the policy mode or rules (an un-gated allow, e.g. observe mode, is "require_approval", never a purge).
 */
export function purgeCardAuthorizer(
  policy: { decide(r: unknown): Promise<{ enforcedOutcome: string; approvalGrantId?: string | null }> },
  projectId: string,
  grantId: string,
  card: { createdAt: Date; archive: string | null; due?: string | null },
  archivedAt: () => Promise<Date | null>,
  purgeAfter?: () => Promise<Date | null>,
): Authorize {
  return async (action, resource) => {
    if (action !== "teardown.purge" || resource !== teardownResource(projectId)) return "deny";
    const since = await archivedAt();
    if (!since || card.createdAt.getTime() < since.getTime()) return "deny";
    // M2.5-b5 decision 8 (Codex PR240-r4): re-read under the project lock, the card must name this very archive.
    if (card.archive !== since.toISOString()) return "deny";
    // M2.5-b5 decision 30 (Codex PR240-r26): a scheduled card purges only while its purge date is still the project's.
    if (card.due) {
      const due = purgeAfter ? await purgeAfter() : null;
      if (!due || due.toISOString() !== card.due) return "deny";
    }
    const d = await policy.decide({ identity: PROVISIONER_IDENTITY, action: { type: action, resource, projectId }, approvalGrantId: grantId });
    if (d.enforcedOutcome === "allow") return d.approvalGrantId === grantId ? "allow" : "require_approval";
    return d.enforcedOutcome === "require_approval" ? "require_approval" : "deny";
  };
}

/** The job waits up to 60 s for the project lock (a provisioning tick or a route may hold it). */
export const PURGE_LOCK_WAIT_MS = 60_000;

export interface TeardownSweepCards {
  list(f: { status?: string; action: string; target?: string; cursor?: string; limit: number }): Promise<PurgeCardLike[]>;
  raise(card: unknown): Promise<unknown>;
  expire(ids: readonly string[], reason: string): Promise<string[]>;
  /** M2.5-b5 decision 51: `Approvals.supersedeCard` (expire and raise in one transaction). */
  supersede(oldId: string, card: unknown, reason: string): Promise<unknown>;
}

/**
 * The teardown sweep's three production queries (M2.5-b2), split out of `buildTeardownSweep` so the Postgres test
 * (`test-db/teardown-sweep-queries.test.mjs`, DEVOS-112 follow-up) runs the exact query code against a real database.
 */
export function teardownSweepQueries(db: any, timeoutMs: number): Pick<TeardownSweepDeps, "listDue" | "unspentGrant" | "keepArchived"> {
  const tx = <T>(fn: (tx: any) => Promise<T>): Promise<T> => db.$transaction(fn, { timeout: timeoutMs, maxWait: timeoutMs });
  return {
    listDue: (now: Date, limit: number) =>
      tx<any[]>((t) => t.project.findMany({
        where: { stage: "archived", purgeAfter: { lte: now } },
        orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
        take: limit,
        select: { id: true, slug: true, stage: true, purgeAfter: true, archivedAt: true },
      })).then((rows: any[]) => rows.map((p) => ({ id: p.id, slug: p.slug, stage: String(p.stage), purgeAfter: p.purgeAfter ?? null, archivedAt: p.archivedAt ?? null }))),
    unspentGrant: async (approvalId: string, now: Date) => {
      const rows: { id: string; uses: number; maxUses: number }[] = await tx((t: any) => t.approvalGrant.findMany({
        where: { approvalId, revokedAt: null, expiresAt: { gt: now }, uses: 0 },
        orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
        take: 5,
        select: { id: true, uses: true, maxUses: true },
      }));
      return rows.find((g) => g.uses === 0 && g.maxUses >= 1)?.id ?? null;
    },
    keepArchived: (projectId: string, from: Date, to: Date, approvalId: string, archivedAt: Date) =>
      tx(async (t: any) => {
        const r = await t.project.updateMany({ where: { id: projectId, stage: "archived", purgeAfter: from, archivedAt }, data: { purgeAfter: to } });
        if (r.count !== 1) return false;
        await t.auditEvent.create({ data: { actor: "system", action: "teardown.keep_archived", summary: "Kept archived another 30 days (purge card rejected)", projectId, details: { approvalId, purgeAfter: to.toISOString() } } });
        return true;
      }),
  };
}

export function buildTeardownSweep(w: {
  mod: ProvisionModule | null;
  td: TeardownRuntimeModule | null;
  db: any;
  databaseUrl: string;
  vault: { reveal(name: string): Promise<string | null> } | null;
  policy: { decide(r: unknown): Promise<{ enforcedOutcome: string }> };
  cards: TeardownSweepCards | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  log: TeardownSweepDeps["log"];
  /** DEVOS-247: the Linear teardown parts (null when the Linear sync is off). */
  linear?: LinearTeardownParts | null;
}): TeardownSweepJob | { off: string } {
  if (!w.mod || !w.td) return { off: "teardown-not-loaded" };
  if (!w.vault) return { off: "teardown-vault-not-configured" };
  if (!w.cards) return { off: "teardown-approvals-off" };
  const cfg = provisionConfig(w.env);
  if ("off" in cfg) return { off: cfg.off };
  const store = new w.td.PrismaTeardownStore(w.db, { databaseUrl: w.databaseUrl, dbTimeoutMs: w.timeoutMs, lockWaitMs: PURGE_LOCK_WAIT_MS });
  const pm = w.mod as unknown as ProvisionTeardownModule;
  const td = w.td;
  const gh = new w.mod.GitHubClient({ token: vaultToken(w.vault as never, "github_token") });
  const cf = new w.mod.CoolifyClient({ origin: cfg.coolifyOrigin, token: vaultToken(w.vault as never, "coolify_api_token") });
  const cards = w.cards;
  const q = teardownSweepQueries(w.db, w.timeoutMs);
  return new TeardownSweepJob({
    listDue: q.listDue,
    project: async (id) => {
      const p = await store.project(id);
      return p ? { id: p.id, slug: p.slug, stage: String(p.stage), purgeAfter: p.purgeAfter ?? null, archivedAt: p.archivedAt ?? null } : null;
    },
    activeCounts: async (id) => {
      const out: Record<string, number> = {};
      for (const r of (await store.activeResources(id)) as readonly { provider: unknown }[]) out[String(r.provider)] = (out[String(r.provider)] ?? 0) + 1;
      return out;
    },
    cards: (f) => cards.list(f),
    raise: (card) => cards.raise(card),
    expire: (ids, reason) => cards.expire(ids, reason),
    supersede: (oldId, card, reason) => cards.supersede(oldId, card, reason),
    unspentGrant: q.unspentGrant,
    purge: async (projectId, grantId, card) => {
      const wiring = await teardownWiring(pm, td, { gh, cf, store, db: w.db, projectId, owner: cfg.owner, timeoutMs: w.timeoutMs, linear: w.linear ?? null });
      const authorize = purgeCardAuthorizer(
        w.policy, projectId, grantId, card,
        async () => (await store.project(projectId))?.archivedAt ?? null,
        async () => (await store.project(projectId))?.purgeAfter ?? null,
      );
      return td.purgeProject(projectId, { store, authorize, ops: wiring.ops, scanners: wiring.scanners, preflight: wiring.preflight });
    },
    keepArchived: q.keepArchived,
    log: w.log,
    // M2.5-b5 decision 1 (DEVOS-255): KK's early ask holds the same lifecycle lock as Archive, Restore and Purge.
    locked: (projectId, fn) => store.withProjectLock(projectId, fn),
    // M2.5-b5 decision 4 (Codex PR240-r1): the lock session is pinged right before a purge card is written.
    lockHeld: (projectId) => store.assertLockHeld(projectId),
  });
}
