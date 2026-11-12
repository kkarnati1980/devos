// In-memory TeardownStore over M2.4's MemoryStore (one shared inventory and step journal), for tests and dry runs.
// Same semantics as the Postgres store (M2.5-a2).
import { MemoryStore, type ResourceRecord } from "@devos/provision";
import type { ActiveResource, ScanReport, TeardownProject, TeardownStore } from "./teardown.js";

interface Row extends ResourceRecord {
  projectId: string;
  id: string;
  deletedAt?: Date;
}

export class MemoryTeardownStore extends MemoryStore implements TeardownStore {
  readonly projects = new Map<string, TeardownProject>();
  readonly scans: ScanReport[] = [];
  /** Project-scoped vault secrets (names only; no values in tests). */
  readonly secrets: { projectId: string; name: string }[] = [];
  /** Audit events written with a secrets delete (mirrors the Postgres store). */
  readonly audits: { projectId: string; action: string; details: { count: number; names: string[] } }[] = [];
  private seq = 0;

  addProject(p: { id: string; slug: string; stage?: string }): void {
    this.projects.set(p.id, { id: p.id, slug: p.slug, stage: p.stage ?? "building", previousStage: null, archivedAt: null, purgeAfter: null });
  }

  /** Inventory upsert that ignores deleted rows, so a purged name can be provisioned fresh (AT7). */
  override async recordResource(projectId: string, r: ResourceRecord): Promise<void> {
    const rows = this.resources as Row[];
    const hit = rows.find((x) => !x.deletedAt && x.provider === r.provider && x.kind === r.kind && x.externalId === r.externalId);
    if (hit) {
      if (hit.projectId !== projectId) throw new Error("resource_owned_elsewhere");
      return;
    }
    rows.push({ ...r, projectId, id: `res-${++this.seq}` });
  }

  async project(projectId: string): Promise<TeardownProject | null> {
    const p = this.projects.get(projectId);
    return p ? { ...p } : null;
  }

  private patch(projectId: string, change: Partial<TeardownProject>): void {
    const p = this.projects.get(projectId);
    if (!p) throw new Error("project_not_found");
    this.projects.set(projectId, { ...p, ...change });
  }

  async markArchived(projectId: string, at: Date, purgeAfter: Date): Promise<void> {
    const p = this.projects.get(projectId);
    this.patch(projectId, { previousStage: p?.stage ?? null, stage: "archived", archivedAt: at, purgeAfter });
  }

  async markRestored(projectId: string): Promise<void> {
    const p = this.projects.get(projectId);
    this.patch(projectId, { stage: p?.previousStage ?? "building", previousStage: null, archivedAt: null, purgeAfter: null });
  }

  async activeResources(projectId: string): Promise<ActiveResource[]> {
    return (this.resources as Row[])
      .filter((r) => r.projectId === projectId && !r.deletedAt)
      .map((r) => ({ id: r.id, provider: r.provider, kind: r.kind, externalId: r.externalId, name: r.name }));
  }

  /** Tests set this to throw once before the row update (AT4: crash after the provider delete). */
  failNextMarkDeleted = false;
  async markResourceDeleted(resourceId: string, at: Date): Promise<void> {
    if (this.failNextMarkDeleted) {
      this.failNextMarkDeleted = false;
      throw new Error("simulated crash before the inventory update");
    }
    const r = (this.resources as Row[]).find((x) => x.id === resourceId);
    if (r && !r.deletedAt) r.deletedAt = at;
  }

  async resetSteps(projectId: string): Promise<void> {
    for (const k of [...this.steps.keys()]) if (k.startsWith(`${projectId}/`)) this.steps.delete(k);
  }

  async saveScan(_projectId: string, report: ScanReport): Promise<void> {
    this.scans.push(report);
  }

  async deleteProjectSecrets(projectId: string): Promise<number> {
    const names = this.secrets.filter((x) => x.projectId === projectId).map((x) => x.name).sort();
    if (!names.length) return 0;
    for (let i = this.secrets.length - 1; i >= 0; i--) if (this.secrets[i]?.projectId === projectId) this.secrets.splice(i, 1);
    this.audits.push({ projectId, action: "teardown.secrets_deleted", details: { count: names.length, names } });
    return names.length;
  }

  /** A vault leftover scanner over `secrets` (test stand-in for the Postgres `vaultScanner`; ids are synthetic). */
  vaultScanner(): { name: string; scan: (p: { id: string }) => Promise<{ provider: string; kind: string; externalId: string; name: string }[]> } {
    return {
      name: "vault",
      scan: async (p) => this.secrets.filter((x) => x.projectId === p.id).map((x) => ({ provider: "vault", kind: "secret", externalId: `mem-${x.projectId}-${x.name}`, name: x.name })),
    };
  }

  async markPurged(projectId: string): Promise<void> {
    this.patch(projectId, { stage: "purged" });
  }
}
