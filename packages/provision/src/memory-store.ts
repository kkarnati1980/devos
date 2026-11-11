// In-memory ProvisionStore for tests and dry runs; same semantics as the Prisma store.
import type { ProvisionStore, ResourceRecord, StepRecord, StepSpec } from "./runner.js";

type Spec = Pick<StepSpec, "key" | "provider" | "kind">;

export class MemoryStore implements ProvisionStore {
  readonly steps = new Map<string, StepRecord & { provider: string; kind: string }>();
  readonly resources: (ResourceRecord & { projectId: string })[] = [];
  private readonly locks = new Map<string, Promise<unknown>>();

  async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(projectId, run.catch(() => {}));
    return run;
  }

  async getStep(projectId: string, key: string): Promise<StepRecord | null> {
    const s = this.steps.get(`${projectId}/${key}`);
    return s ? { ...s } : null;
  }

  private upsert(projectId: string, spec: Spec, patch: Partial<StepRecord>): void {
    const id = `${projectId}/${spec.key}`;
    const cur = this.steps.get(id) ?? { projectId, key: spec.key, provider: spec.provider, kind: spec.kind, status: "pending" as const, attempts: 0, externalId: null, lastError: null };
    this.steps.set(id, { ...cur, ...patch });
  }

  async markPending(projectId: string, spec: Spec): Promise<void> {
    const cur = this.steps.get(`${projectId}/${spec.key}`);
    this.upsert(projectId, spec, { status: "pending", attempts: (cur?.attempts ?? 0) + 1 });
  }

  async markDone(projectId: string, spec: Spec, externalId: string): Promise<void> {
    this.upsert(projectId, spec, { status: "done", externalId, lastError: null });
  }

  async markFailed(projectId: string, spec: Spec, error: string): Promise<void> {
    this.upsert(projectId, spec, { status: "failed", lastError: error.slice(0, 300) });
  }

  async recordResource(projectId: string, r: ResourceRecord): Promise<void> {
    const hit = this.resources.find((x) => x.provider === r.provider && x.kind === r.kind && x.externalId === r.externalId);
    if (hit) {
      if (hit.projectId !== projectId) throw new Error("resource_owned_elsewhere");
      return;
    }
    this.resources.push({ ...r, projectId });
  }
}
