// M1.4 settings (docs/modules/M1.4.md): the three USD caps (O5), default lanes, deadlock attempts,
// per-project cap + lanes, and the analyst model pass switch (DEVOS-176). Validated at the boundary (BS-A01); unknown fields are refused.

export const CAP_MIN = 0.01;
export const CAP_MAX = 10000;
export const LANES_MAX = 3; // D8 / D9: 3 lanes at most
export const DEADLOCK_MIN = 1;
export const DEADLOCK_MAX = 5;

export interface AppSettingsView {
  anthropicCapUsd: string;
  openaiCapUsd: string;
  defaultProjectCapUsd: string;
  defaultLanes: number;
  maxLanes: number;
  deadlockAttempts: number;
  /** DEVOS-176: `analyst.model_pass`, default off. Read by the requirements pipeline before each pass. */
  analystModelPass: boolean;
  capsConfirmedAt: string | null;
  updatedAt: string | null;
}

export interface AppSettingsPatch {
  anthropicCapUsd?: string;
  openaiCapUsd?: string;
  defaultProjectCapUsd?: string;
  defaultLanes?: number;
  deadlockAttempts?: number;
  analystModelPass?: boolean;
}

export interface ProjectSettingsPatch {
  capUsd?: string;
  lanes?: number;
}

export interface ProjectSettingsView {
  id: string;
  slug: string;
  capUsd: string;
  lanes: number;
}

/** An `audit_event` row (actor `kk`) written in the same transaction as the change it records. */
export interface AuditEntry {
  action: string;
  summary: string;
  details: Record<string, unknown>;
  projectId?: string | null;
}

/**
 * Every mutation commits atomically with its audit event (PR17-r1): if the audit insert fails,
 * the change is rolled back and the route answers 503.
 */
export interface SettingsStore {
  get(): Promise<AppSettingsView>;
  /** Applies the patch and stamps `capsConfirmedAt` (the wizard's caps step). */
  update(patch: AppSettingsPatch, confirmedAt: Date, audit: AuditEntry): Promise<AppSettingsView>;
  updateProject(id: string, patch: ProjectSettingsPatch, audit: AuditEntry): Promise<ProjectSettingsView | "not-found" | "archived">;
}

/** A USD amount: number or string, 0.01–10,000, at most 2 decimals. Normalised to "15.00". */
export function parseUsd(v: unknown): string | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") s = v;
  else return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (n < CAP_MIN || n > CAP_MAX) return null;
  return n.toFixed(2);
}

const int = (v: unknown, min: number, max: number): number | null =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null;

const APP_KEYS = new Set(["anthropicCapUsd", "openaiCapUsd", "defaultProjectCapUsd", "defaultLanes", "deadlockAttempts", "analystModelPass"]);
const PROJECT_KEYS = new Set(["capUsd", "lanes"]);

function objectBody(body: unknown): Record<string, unknown> | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body-must-be-object";
  return body as Record<string, unknown>;
}

/**
 * Wizard caps step and settings page. The wizard sends all three caps; the settings page may send
 * any subset, but at least one field.
 */
export function parseAppSettings(body: unknown, maxLanes: number, requireCaps: boolean): AppSettingsPatch | string {
  const b = objectBody(body);
  if (typeof b === "string") return b;
  for (const k of Object.keys(b)) if (!APP_KEYS.has(k)) return `unknown-field:${k}`;
  if (Object.keys(b).length === 0) return "body-empty";
  const out: AppSettingsPatch = {};
  for (const k of ["anthropicCapUsd", "openaiCapUsd", "defaultProjectCapUsd"] as const) {
    if (b[k] === undefined) {
      if (requireCaps) return `missing:${k}`;
      continue;
    }
    const usd = parseUsd(b[k]);
    if (usd === null) return `invalid:${k}`;
    out[k] = usd;
  }
  if (b.defaultLanes !== undefined) {
    const n = int(b.defaultLanes, 1, Math.min(maxLanes, LANES_MAX));
    if (n === null) return "invalid:defaultLanes";
    out.defaultLanes = n;
  }
  if (b.deadlockAttempts !== undefined) {
    const n = int(b.deadlockAttempts, DEADLOCK_MIN, DEADLOCK_MAX);
    if (n === null) return "invalid:deadlockAttempts";
    out.deadlockAttempts = n;
  }
  if (b.analystModelPass !== undefined) {
    // Only a JSON boolean: "true", 1 or "on" are refused, so a typo never turns model spend on.
    if (typeof b.analystModelPass !== "boolean") return "invalid:analystModelPass";
    out.analystModelPass = b.analystModelPass;
  }
  return out;
}

export function parseProjectSettings(body: unknown, maxLanes: number): ProjectSettingsPatch | string {
  const b = objectBody(body);
  if (typeof b === "string") return b;
  for (const k of Object.keys(b)) if (!PROJECT_KEYS.has(k)) return `unknown-field:${k}`;
  if (Object.keys(b).length === 0) return "body-empty";
  const out: ProjectSettingsPatch = {};
  if (b.capUsd !== undefined) {
    const usd = parseUsd(b.capUsd);
    if (usd === null) return "invalid:capUsd";
    out.capUsd = usd;
  }
  if (b.lanes !== undefined) {
    const n = int(b.lanes, 1, Math.min(maxLanes, LANES_MAX));
    if (n === null) return "invalid:lanes";
    out.lanes = n;
  }
  return out;
}

const DEFAULTS: AppSettingsView = {
  anthropicCapUsd: "15.00",
  openaiCapUsd: "15.00",
  defaultProjectCapUsd: "15.00",
  defaultLanes: 2,
  maxLanes: 3,
  deadlockAttempts: 3,
  analystModelPass: false,
  capsConfirmedAt: null,
  updatedAt: null,
};

/** In-memory store for tests and local runs. `failAudit` simulates an audit insert failing. */
export class MemorySettingsStore implements SettingsStore {
  settings: AppSettingsView = { ...DEFAULTS };
  failAudit = false;
  readonly projects = new Map<string, ProjectSettingsView & { archived: boolean }>();
  readonly audits: { action: string; summary: string; details: Record<string, unknown>; projectId: string | null }[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  private record(a: AuditEntry) {
    if (this.failAudit) throw new Error("audit insert failed");
    this.audits.push({ action: a.action, summary: a.summary, details: a.details, projectId: a.projectId ?? null });
  }
  async get() {
    return { ...this.settings };
  }
  async update(patch: AppSettingsPatch, confirmedAt: Date, audit: AuditEntry) {
    const next = { ...this.settings, ...patch, capsConfirmedAt: confirmedAt.toISOString(), updatedAt: new Date(this.now()).toISOString() };
    this.record(audit); // before the change is applied: a failed audit leaves nothing changed
    this.settings = next;
    return { ...this.settings };
  }
  async updateProject(id: string, patch: ProjectSettingsPatch, audit: AuditEntry) {
    const p = this.projects.get(id);
    if (!p) return "not-found" as const;
    if (p.archived) return "archived" as const;
    this.record(audit);
    Object.assign(p, patch);
    return { id: p.id, slug: p.slug, capUsd: p.capUsd, lanes: p.lanes };
  }
}

const usd = (d: unknown) => Number(String(d)).toFixed(2);

function view(row: any): AppSettingsView {
  return {
    anthropicCapUsd: usd(row.anthropicCapUsd),
    openaiCapUsd: usd(row.openaiCapUsd),
    defaultProjectCapUsd: usd(row.defaultProjectCapUsd),
    defaultLanes: row.defaultLanes,
    maxLanes: row.maxLanes,
    deadlockAttempts: row.deadlockAttempts,
    analystModelPass: row.analystModelPass === true,
    capsConfirmedAt: row.capsConfirmedAt ? new Date(row.capsConfirmedAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

/** Prisma-backed store: the `app_settings` singleton row and `project`. Every operation, reads
 * included, runs in a transaction bounded by `timeout` and `maxWait` (ADR-0011 §9, PR17-r1). */
export class PrismaSettingsStore implements SettingsStore {
  constructor(
    private readonly db: any,
    private readonly timeoutMs: number,
  ) {}
  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }
  async get() {
    return this.tx(async (tx) => {
      const row = await tx.appSettings.findUnique({ where: { singleton: true } });
      return row ? view(row) : { ...DEFAULTS };
    });
  }
  async update(patch: AppSettingsPatch, confirmedAt: Date, audit: AuditEntry) {
    return this.tx(async (tx) => {
      const data = { ...patch, capsConfirmedAt: confirmedAt };
      const row = await tx.appSettings.upsert({ where: { singleton: true }, update: data, create: { singleton: true, ...data } });
      await writeAudit(tx, audit);
      return view(row);
    });
  }
  async updateProject(id: string, patch: ProjectSettingsPatch, audit: AuditEntry) {
    return this.tx(async (tx) => {
      const p = await tx.project.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
      if (!p) return "not-found" as const;
      if (p.archivedAt) return "archived" as const;
      const row = await tx.project.update({ where: { id }, data: patch, select: { id: true, slug: true, capUsd: true, lanes: true } });
      await writeAudit(tx, audit);
      return { id: row.id, slug: row.slug, capUsd: usd(row.capUsd), lanes: row.lanes };
    });
  }
}

/** Inserts the audit row inside the caller's transaction. */
export async function writeAudit(tx: any, a: AuditEntry): Promise<void> {
  await tx.auditEvent.create({ data: { actor: "kk", action: a.action, summary: a.summary, details: a.details, projectId: a.projectId ?? null } });
}
