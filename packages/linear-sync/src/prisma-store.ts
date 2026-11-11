// M2.6-a: the DevOS side of the sync over the M1.1 Prisma client (@devos/db createDb). Typed structurally so
// this package has no runtime dependency on the generated client (same pattern as @devos/policy).
// Linear project and milestone ids are resource rows (provider 'linear'); module/task issues use linear_issue.
import type { DevosPlan, SyncStore } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = any;
export interface PrismaLike {
  project: Delegate; milestone: Delegate; module: Delegate; moduleDependency: Delegate; task: Delegate; resource: Delegate;
}

const RES = (kind: "project" | "milestone") => ({ provider: "linear", kind });

/** Read the plan of one project, with the Linear ids already known. */
export async function loadPlan(db: PrismaLike, projectId: string): Promise<DevosPlan> {
  const p = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!p) throw new Error("linear-sync: project not found");
  const [milestones, modules, tasks, resources] = await Promise.all([
    db.milestone.findMany({ where: { projectId }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, name: true, gateName: true } }),
    db.module.findMany({ where: { projectId }, orderBy: { key: "asc" }, select: { id: true, milestoneId: true, key: true, title: true, lane: true, contractPath: true, status: true, linearIssue: true } }),
    db.task.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, moduleId: true, title: true, kind: true, assignee: true, status: true, linearIssue: true } }),
    db.resource.findMany({ where: { projectId, provider: "linear", status: "active" }, select: { kind: true, externalId: true, name: true } }),
  ]);
  const moduleIds = modules.map((m: { id: string }) => m.id);
  const dependencies = moduleIds.length
    ? await db.moduleDependency.findMany({ where: { moduleId: { in: moduleIds } }, select: { moduleId: true, dependsOnId: true } })
    : [];
  // Resource rows name what they mirror: the project row's name is the project id, a milestone row's is the milestone id.
  const res = (kind: string, name: string) => resources.find((r: { kind: string; name: string }) => r.kind === kind && r.name === name)?.externalId ?? null;
  return {
    project: { id: p.id, name: p.name, linearProjectId: res("project", p.id) },
    milestones: milestones.map((m: any) => ({ ...m, linearMilestoneId: res("milestone", m.id) })),
    modules, dependencies, tasks,
  };
}

export class PrismaSyncStore implements SyncStore {
  constructor(private readonly db: PrismaLike, private readonly projectId: string) {}

  private async upsertResource(kind: "project" | "milestone", name: string, externalId: string) {
    const existing = await this.db.resource.findFirst({ where: { projectId: this.projectId, ...RES(kind), name, status: "active" }, select: { id: true, externalId: true } });
    if (existing?.externalId === externalId) return;
    // The same Linear object may have a soft-deleted row (resource is unique on provider + kind + external id): reuse it.
    const prior = await this.db.resource.findFirst({ where: { ...RES(kind), externalId }, select: { id: true, projectId: true } });
    if (prior && prior.projectId === this.projectId) {
      if (existing) await this.db.resource.update({ where: { id: existing.id }, data: { status: "deleted", deletedAt: new Date() } });
      await this.db.resource.update({ where: { id: prior.id }, data: { status: "active", deletedAt: null, name } });
      return;
    }
    if (existing) await this.db.resource.update({ where: { id: existing.id }, data: { externalId } });
    else await this.db.resource.create({ data: { projectId: this.projectId, ...RES(kind), name, externalId } });
  }
  setProjectId(projectId: string, linearProjectId: string) { return this.upsertResource("project", projectId, linearProjectId); }
  setMilestoneId(milestoneId: string, linearMilestoneId: string) { return this.upsertResource("milestone", milestoneId, linearMilestoneId); }
  async setModuleIssue(moduleId: string, issueId: string) { await this.db.module.update({ where: { id: moduleId }, data: { linearIssue: issueId } }); }
  async setTaskIssue(taskId: string, issueId: string) { await this.db.task.update({ where: { id: taskId }, data: { linearIssue: issueId } }); }
}
