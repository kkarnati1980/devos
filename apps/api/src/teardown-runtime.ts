// DEVOS-244 (M2.5-b1, docs/modules/M2.5.md "M2.5-b1 decisions"): the production wiring behind the archive and
// restore routes. Every action is built from teardownWiring (one pinned GitHub and one pinned Coolify client per
// call), PrismaTeardownStore with the provisioning advisory lock, and the M1.7 engine deciding for KK's own session
// (never `allowAll`). Off, with a code, when the modules, the vault or the provisioning settings are missing.
import type { KkSession } from "./auth.js";
import { provisionConfig, vaultToken, type ProvisionModule } from "./provision-runtime.js";
import { teardownWiring, type ProvisionTeardownModule, type TeardownModule, type TeardownStoreLike } from "./teardown-wiring.js";
import type { ScanReportLike, TeardownActions, TeardownProjectRow, TeardownReader, TeardownServices } from "./teardown-routes.js";

type Authorize = (action: string, resource: string) => Promise<"allow" | "deny" | "require_approval">;

/** What `@devos/teardown` exports that the routes use (loaded at run time, like @devos/provision). */
export interface TeardownRuntimeModule extends TeardownModule {
  restoreProject(projectId: string, o: Record<string, unknown>): Promise<void>;
  PrismaTeardownStore: new (db: unknown, o: Record<string, unknown>) => TeardownStoreLike & {
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
    (await teardownWiring(pm, td, { gh, cf, store, db: w.db, projectId, owner: cfg.owner, timeoutMs: w.timeoutMs })).ops;
  const actions: TeardownActions = {
    archive: async (session, projectId, windowDays) =>
      td.archiveProject(projectId, { store, authorize: kkAuthorizer(w.policy, session, projectId), ops: await ops(projectId), windowDays }) as Promise<{ archivedAt: Date; purgeAfter: Date }>,
    restore: async (session, projectId) =>
      td.restoreProject(projectId, { store, authorize: kkAuthorizer(w.policy, session, projectId), ops: await ops(projectId) }),
  };
  return { reader: new PrismaTeardownReader(w.db, store, w.timeoutMs), actions };
}

