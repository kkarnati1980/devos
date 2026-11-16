// M2.5-b1 (DEVOS-244, docs/modules/M2.5.md "M2.5-b split", shared rule): the production teardown wiring, moved
// unchanged from provision-probe-purge.ts (DEVOS-234 decision 2) so the AT13 probe and the product's archive, restore
// and purge paths share one copy: one pinned GitHub and one pinned Coolify client per purge, the vault scanner in
// every scanner list, and both token-scope checks in every preflight list.
export type Ops = { provider: string; kind: string };
export type Scanner = { name: string };

/** The `@devos/provision` teardown exports the wiring uses, read structurally (the package is loaded at run time). */
export interface ProvisionTeardownModule {
  pinnedGitHub(gh: unknown): Promise<unknown>;
  pinnedCoolify(cf: unknown): Promise<unknown>;
  githubRepoOps(gh: unknown, projectId: string): Ops;
  githubDeployKeyOps(gh: unknown, projectId: string): Ops;
  coolifyProjectOps(cf: unknown, projectId: string): Ops;
  coolifyEnvironmentOps(cf: unknown, projectId: string): Ops;
  coolifyApplicationOps(cf: unknown, projectId: string): Ops;
  coolifyPrivateKeyOps(cf: unknown, projectId: string): Ops;
  coolifyPortOps(): Ops;
  backupScheduleOps(): Ops;
  githubScanner(gh: unknown): Scanner;
  coolifyScanner(cf: unknown): Scanner;
  githubTokenScopeCheck(gh: unknown, o: { owner: string }): () => Promise<void>;
  coolifyTokenScopeCheck(cf: unknown, recorded: () => Promise<readonly unknown[]>): () => Promise<void>;
}

/** The `@devos/teardown` exports the wiring uses. */
export interface TeardownModule {
  archiveProject(projectId: string, o: Record<string, unknown>): Promise<unknown>;
  purgeProject(projectId: string, o: Record<string, unknown>): Promise<{ purged: boolean; report: { hits: { provider: string; kind: string }[]; errors: unknown[] } }>;
  inventoryScanner(store: unknown): Scanner;
  vaultScanner(db: unknown, timeoutMs?: number): Scanner;
}

export interface TeardownStoreLike {
  activeResources(projectId: string): Promise<readonly unknown[]>;
}

/**
 * Decision 2: the production teardown wiring, built once per purge from one pinned GitHub and one pinned Coolify
 * client (DEVOS-235 decision 4), so every op, scanner and check of that purge uses the same token snapshot.
 * M2.5-b (DEVOS-112) reuses it.
 */
export async function teardownWiring(
  pm: ProvisionTeardownModule,
  tm: TeardownModule,
  w: { gh: unknown; cf: unknown; store: TeardownStoreLike; db: unknown; projectId: string; owner: string; timeoutMs: number;
       /** DEVOS-247 (M2.6-b2b2): the project's Linear ops and scanner, when the Linear sync is on. */
       linear?: ((projectId: string) => { ops: Ops[]; scanners: Scanner[] }) | null },
): Promise<{ ops: Ops[]; scanners: Scanner[]; preflight: (() => Promise<void>)[] }> {
  const gh = await pm.pinnedGitHub(w.gh);
  const cf = await pm.pinnedCoolify(w.cf);
  const id = w.projectId;
  const linear = w.linear ? w.linear(id) : { ops: [], scanners: [] };
  return {
    ops: [
      pm.githubRepoOps(gh, id),
      pm.githubDeployKeyOps(gh, id),
      pm.coolifyProjectOps(cf, id),
      pm.coolifyEnvironmentOps(cf, id),
      pm.coolifyApplicationOps(cf, id),
      pm.coolifyPrivateKeyOps(cf, id),
      pm.coolifyPortOps(),
      pm.backupScheduleOps(),
      ...linear.ops,
    ],
    // Pre-review 1 (high): purgeProject needs a scanner per provider with ops. A backup schedule exists only as an
    // inventory row (nothing at a provider), which the inventory scanner already sees, so its own scan is empty.
    scanners: [tm.inventoryScanner(w.store), tm.vaultScanner(w.db, w.timeoutMs), pm.githubScanner(gh), pm.coolifyScanner(cf), BACKUP_SCHEDULE_SCANNER, ...linear.scanners],
    preflight: [pm.githubTokenScopeCheck(gh, { owner: w.owner }), pm.coolifyTokenScopeCheck(cf, () => w.store.activeResources(id))],
  };
}

const BACKUP_SCHEDULE_SCANNER = { name: "backup_schedule", scan: async (): Promise<never[]> => [] };

/** The resource string `@devos/teardown` authorizes (its `check`), shared so the grant pre-check asks the same question. */
export const teardownResource = (projectId: string): string => `project:${projectId}`;
