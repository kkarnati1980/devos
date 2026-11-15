// DEVOS-224 (M2.4-d1, docs/modules/M2.4.md "M2.4-d split and d1 decisions"): the provisioning sweep.
// Approving a project's requirements moves it from `intake` to `provisioning` in the approval's transaction; this
// job takes every `provisioning` project, runs the full step list under the per-project lock (inside runProvision),
// and moves the project to `building` when every step is done. A retryable failure is re-run on the next tick (the
// step journal makes that safe); a non-retryable one, or 5 failed ticks in a row, parks the project until a retry
// (M2.4-d2's POST). A `name_conflict` raises one decision card per (project, step). Ticks never overlap.
// Pure: every dependency is injected, so the package `@devos/provision` is wired in by runtime.ts, not imported here.

export interface ProvisioningProject {
  id: string;
  slug: string;
  /** The repo description (github/repo step). */
  name: string;
}

/** The fields of `@devos/provision`'s StepError the sweep reads (structural, so no import is needed). */
interface StepErrorLike {
  name: string;
  step: string;
  code: string;
  retryable: boolean;
}

const isStepError = (e: unknown): e is StepErrorLike =>
  e instanceof Error && e.name === "StepError" && typeof (e as unknown as StepErrorLike).code === "string";

export interface ProvisionSweepDeps {
  /** Projects in stage `provisioning`, oldest first. */
  listProvisioning(): Promise<ProvisioningProject[]>;
  /** Runs the project's full ordered step list (runProvision with the M1.7 authorizer); throws StepError on a stop. */
  provision(p: ProvisioningProject): Promise<unknown>;
  /** `provisioning` → `building`, only from `provisioning` (a no-op otherwise). */
  markBuilding(projectId: string): Promise<void>;
  /** Opens the "rename or adopt" card for (project, step) unless one is already open; never throws on a duplicate. */
  raiseNameConflict(projectId: string, step: string): Promise<void>;
  log(e: { level: "info" | "warn"; msg: string; projectId?: string; code?: string; step?: string }): void;
  intervalMs?: number;
  /** Failed ticks in a row before a project is parked (default 5). */
  maxFailures?: number;
}

export const PROVISION_TICK_MS = 60_000;

export class ProvisionSweepJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly failures = new Map<string, number>();
  private readonly parked = new Set<string>();

  constructor(private readonly d: ProvisionSweepDeps) {}

  /** M2.4-d2's POST retry: un-parks the project so the next tick takes it again. */
  retry(projectId: string): void {
    this.parked.delete(projectId);
    this.failures.delete(projectId);
  }

  isParked(projectId: string): boolean {
    return this.parked.has(projectId);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      let projects: ProvisioningProject[];
      try {
        projects = await this.d.listProvisioning();
      } catch {
        this.d.log({ level: "warn", msg: "provision-sweep-list-failed" });
        return 0;
      }
      for (const p of projects) {
        if (this.parked.has(p.id)) continue;
        try {
          await this.d.provision(p);
          await this.d.markBuilding(p.id);
          this.failures.delete(p.id);
          done++;
          this.d.log({ level: "info", msg: "provision-done", projectId: p.id });
        } catch (e) {
          await this.onFailure(p, e);
        }
      }
      return done;
    } finally {
      this.running = false;
    }
  }

  private async onFailure(p: ProvisioningProject, e: unknown): Promise<void> {
    // Only fixed codes are logged, never an error's text (it may quote a provider body).
    const code = isStepError(e) ? e.code : "provision-failed";
    const step = isStepError(e) ? e.step : undefined;
    const retryable = isStepError(e) ? e.retryable : true;
    if (isStepError(e) && e.code === "name_conflict") {
      try {
        await this.d.raiseNameConflict(p.id, e.step);
      } catch {
        this.d.log({ level: "warn", msg: "provision-card-failed", projectId: p.id, step });
      }
    }
    const n = (this.failures.get(p.id) ?? 0) + 1;
    this.failures.set(p.id, n);
    const park = !retryable || n >= (this.d.maxFailures ?? 5);
    if (park) this.parked.add(p.id);
    this.d.log({ level: "warn", msg: park ? "provision-parked" : "provision-failed", projectId: p.id, code, step });
  }

  /** Runs one tick now, then every `intervalMs` (default 60 s). */
  start(): this {
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? PROVISION_TICK_MS);
      this.timer.unref?.();
    }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * The M2.3 card for a `name_conflict` (decision 2): a non-technical call for KK, so it is a plain-language "rename or
 * adopt" card. `Approvals.raiseCard` dedupes against a pending twin (same gate, action, target), so a re-run never
 * opens a second card for the same (project, step).
 */
export function nameConflictCard(p: ProvisioningProject, step: string) {
  return {
    gate: "decision" as const,
    action: "provision.name_conflict",
    target: `project:${p.id}/${step}`,
    reason:
      `Setting up project "${p.slug}" stopped: something named for it already exists (step ${step}), and DevOS did not ` +
      `create it, so DevOS will not touch it. Choose: rename the project, or tell DevOS to adopt the existing one.`,
    projectId: p.id,
  };
}
