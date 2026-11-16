// DEVOS-228 (M2.4-d3b, docs/modules/M2.4.md "Part 2"): the AT13 live probe's phase machine.
// One call to `probeStep` advances at most one phase, so each server-agent tick fits its 120 s check limit.
// Every effect is injected (provisioning, inventory, live asserts, purge, the phase log), so the order and
// the outcomes are tested without GitHub or Coolify. Output is fixed codes only: never a provider message.

export const PROBE_SLUG = "devos-probe-m24";
export const PROBE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** A run or purge still "in progress" after this long ends the cycle (`<phase>-timeout`), so a stuck provider never hides. */
export const PROBE_PHASE_MAX_MS = 2 * 60 * 60 * 1000;

export const PHASES = ["run1", "inventory1", "run2", "inventory2", "assert", "purge", "done"] as const;
export type Phase = (typeof PHASES)[number];

/** One inventory row, as AT13 compares it (key, provider, external id, name). */
export interface InventoryRow { key: string; provider: string; externalId: string; name: string }

/** The newest phase record of the current cycle (stored as an audit row `provision.probe_phase`). */
export interface PhaseRecord {
  cycle: number;
  phase: Phase;
  at: string; // ISO time the phase was entered
  fingerprint: string; // hash of the provisioning code in the image when the cycle started
  inventory1?: InventoryRow[];
  result?: { ok: boolean; code: string; detail?: string; cause?: string };
}

export type RunOutcome = "done" | "in_progress" | { error: string };
export type PurgeOutcome = "done" | "in_progress" | { error: string };

export interface ProbeDeps {
  /** null when the sweep is off (provisionConfig / vault): the probe is skipped. */
  offReason(): Promise<string | null>;
  last(): Promise<PhaseRecord | null>;
  record(r: PhaseRecord): Promise<void>;
  /** Ensure the probe project exists (cap 0) and run provisioning once for it, resumably. */
  provisionOnce(): Promise<RunOutcome>;
  inventory(): Promise<InventoryRow[]>;
  /** AT13's live asserts; each failure is a fixed code. */
  liveAsserts(): Promise<string[]>;
  /** M2.5 purge over the recorded ids only. */
  purge(): Promise<PurgeOutcome>;
  fingerprint: string;
  now(): Date;
}

/** exit 0 pass, 1 fail, 3 skipped / in progress (the server agent's codes). */
export interface ProbeTick { exit: 0 | 1 | 3; phase: Phase | "idle"; cycle: number; code: string; detail?: string }

const full = (r: InventoryRow) => `${r.provider}\u0000${r.externalId}\u0000${r.name}`;

/**
 * The first difference between two inventories (by step key, in key order), or null when they are equal row
 * for row. A key that appears twice in one run is itself a difference (`duplicate:`).
 */
export function inventoryDiff(a: InventoryRow[], b: InventoryRow[]): string | null {
  const index = (rows: InventoryRow[], run: string): Map<string, string> | string => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (m.has(r.key)) return `duplicate-in-${run}:${r.key}`;
      m.set(r.key, full(r));
    }
    return m;
  };
  const x = index(a, "run1"), y = index(b, "run2");
  if (typeof x === "string") return x;
  if (typeof y === "string") return y;
  for (const k of [...new Set([...x.keys(), ...y.keys()])].sort()) {
    if (!y.has(k)) return `missing-in-run2:${k}`;
    if (!x.has(k)) return `extra-in-run2:${k}`;
    if (x.get(k) !== y.get(k)) return `differs:${k}`;
  }
  return null;
}

/**
 * Codex PR164-r2: the first incomplete row of one read, or null. A done step without an external id, or without an
 * active resource row behind it (an empty name), is a gap; the same gap in both reads would compare equal, so each
 * read is checked on its own before the compare. Checked in key order, so the row named is stable.
 */
export function inventoryIncomplete(rows: InventoryRow[]): string | null {
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (r.externalId === "") return `no-external-id:${r.key}`;
    if (r.name === "") return `no-active-resource:${r.key}`;
  }
  return null;
}

function nextPhase(p: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(p) + 1, PHASES.length - 1)] ?? "done";
}

function due(last: PhaseRecord, d: ProbeDeps): boolean {
  if (last.fingerprint !== d.fingerprint) return true;
  return d.now().getTime() - Date.parse(last.at) >= PROBE_EVERY_MS;
}

/** Runs one effect; a throw becomes `{ thrown: true }` (its message is never kept: it may quote a provider body). */
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await fn() }; } catch { return { ok: false }; }
}

/**
 * Advances the probe by at most one phase and writes at most one phase row per call (so two rows of one call
 * can never tie on `occurredAt`, pre-review L2). Any failure it can see before `purge` goes to `purge` with its
 * fixed code, so the probe never leaves resources behind; a run or purge still in progress, or throwing, for
 * PROBE_PHASE_MAX_MS ends the cycle (pre-review M1).
 */
export async function probeStep(d: ProbeDeps): Promise<ProbeTick> {
  const off = await d.offReason();
  if (off) return { exit: 3, phase: "idle", cycle: 0, code: "skipped", detail: off };
  const last = await d.last();
  const at = () => d.now().toISOString();

  if (!last || (last.phase === "done" && due(last, d))) {
    const cycle = (last?.cycle ?? 0) + 1;
    await d.record({ cycle, phase: "run1", at: at(), fingerprint: d.fingerprint });
    return { exit: 3, phase: "run1", cycle, code: "in_progress" };
  }
  if (last.phase === "done") {
    // Reported once when it finished; later ticks are skipped until the next cycle is due.
    return { exit: 3, phase: "done", cycle: last.cycle, code: "probed", detail: last.result?.code };
  }

  const { cycle, phase } = last;
  const timedOut = () => d.now().getTime() - Date.parse(last.at) >= PROBE_PHASE_MAX_MS;
  const failed = (code: string, detail?: string) => ({ ok: false, code, detail });
  const toPurge = async (result: { ok: boolean; code: string; detail?: string }): Promise<ProbeTick> => {
    await d.record({ ...last, phase: "purge", at: at(), result });
    return { exit: 3, phase: "purge", cycle, code: "in_progress" };
  };
  const advance = async (extra: Partial<PhaseRecord> = {}): Promise<ProbeTick> => {
    const to = nextPhase(phase);
    await d.record({ ...last, ...extra, phase: to, at: at() });
    return { exit: 3, phase: to, cycle, code: "in_progress" };
  };
  const finish = async (ok: boolean, code: string, detail?: string, cause?: string): Promise<ProbeTick> => {
    const result = { ok, code, ...(detail !== undefined ? { detail } : {}), ...(cause ? { cause } : {}) };
    await d.record({ ...last, phase: "done", at: at(), result });
    return { exit: ok ? 0 : 1, phase: "done", cycle, code, detail };
  };

  // Pre-review L3: a deploy that changed the provisioning code mid-cycle makes the compare meaningless.
  if (last.fingerprint !== d.fingerprint && phase !== "purge") return toPurge(failed("fingerprint-changed"));

  switch (phase) {
    case "run1":
    case "run2": {
      const r = await attempt(() => d.provisionOnce());
      const v = r.ok ? r.value : "in_progress";
      if (v === "done") return advance();
      if (v === "in_progress" && !timedOut()) return { exit: 3, phase, cycle, code: "in_progress" };
      // Purge whatever the failed run created, then report the run's failure (kept in the record).
      return toPurge(failed(`${phase}-failed`, v === "in_progress" ? "timeout" : v.error));
    }
    case "inventory1": {
      const r = await attempt(() => d.inventory());
      if (!r.ok) return toPurge(failed("inventory1-failed", "error"));
      const gap = inventoryIncomplete(r.value);
      return gap ? toPurge(failed("inventory-incomplete", `run1:${gap}`)) : advance({ inventory1: r.value });
    }
    case "inventory2": {
      const r = await attempt(() => d.inventory());
      if (!r.ok) return toPurge(failed("inventory2-failed", "error"));
      const gap = inventoryIncomplete(r.value);
      if (gap) return toPurge(failed("inventory-incomplete", `run2:${gap}`));
      const diff = inventoryDiff(last.inventory1 ?? [], r.value);
      // A failed compare still purges the probe's resources: the failure is kept in the record.
      return diff ? toPurge(failed("inventory-differs", diff)) : advance();
    }
    case "assert": {
      const r = await attempt(() => d.liveAsserts());
      if (!r.ok) return toPurge(failed("live-assert-failed", "error"));
      return r.value.length ? toPurge(failed("live-assert-failed", r.value.join(","))) : advance();
    }
    case "purge": {
      const r = await attempt(() => d.purge());
      const v = r.ok ? r.value : "in_progress";
      const earlier = last.result && !last.result.ok ? last.result : undefined;
      if (v === "in_progress" && !timedOut()) return { exit: 3, phase, cycle, code: "in_progress" };
      // Pre-review L1: the earlier failure stays in the done row as `cause`.
      if (v !== "done") return finish(false, "purge-failed", v === "in_progress" ? (r.ok ? "timeout" : "error-timeout") : v.error, earlier?.code);
      if (earlier) return finish(false, earlier.code, earlier.detail);
      return finish(true, "pass");
    }
    default:
      return { exit: 1, phase, cycle, code: "unknown-phase" };
  }
}

/**
 * The probe project's row: paused from creation, so the provisioning sweep (which lists only unpaused
 * `provisioning` projects) never picks it; only the probe runs provisioning for it. Cap 0: it spends nothing.
 */
export const PROBE_PROJECT_DATA = {
  slug: PROBE_SLUG,
  name: "DevOS provisioning probe (AT13)",
  capUsd: 0,
  continuousRun: false,
  preflightState: "approved",
} as const;

/** Find or create the probe project; only that row is written. Bounded like every DevOS DB call (ADR-0011 §9). */
export async function ensureProbeProject(db: any, now: Date, timeoutMs: number): Promise<{ id: string; slug: string; name: string }> {
  return db.$transaction(async (tx: any) => {
    const found = await tx.project.findUnique({ where: { slug: PROBE_SLUG }, select: { id: true, slug: true, name: true, pausedAt: true } });
    if (found) {
      // Pre-review M2: only a row the probe created (its `provision.probe_started` audit row) is adopted. A real
      // project that took the slug is never paused, provisioned or purged; the probe stops with a fixed code.
      const mine = await tx.auditEvent.findFirst({ where: { projectId: found.id, action: "provision.probe_started" }, select: { id: true } });
      if (!mine) throw new Error("probe-slug-taken");
      if (!found.pausedAt) await tx.project.updateMany({ where: { id: found.id, pausedAt: null }, data: { pausedAt: now } });
      return { id: found.id, slug: found.slug, name: found.name };
    }
    const p = await tx.project.create({ data: { ...PROBE_PROJECT_DATA, pausedAt: now }, select: { id: true, slug: true, name: true } });
    await tx.auditEvent.create({ data: { actor: "system", action: "provision.probe_started", summary: "AT13 provisioning probe project created", projectId: p.id } });
    return p;
  }, { timeout: timeoutMs, maxWait: timeoutMs });
}

const PHASE_ACTION = "provision.probe_phase";

function asRecord(details: unknown): PhaseRecord | null {
  const d = details as Partial<PhaseRecord> | null;
  if (!d || typeof d !== "object") return null;
  if (!Number.isInteger(d.cycle) || !PHASES.includes(d.phase as Phase) || typeof d.at !== "string" || typeof d.fingerprint !== "string") return null;
  return d as PhaseRecord;
}

/** The phase log as append-only audit rows on the probe project (no migration). An unreadable newest row is an error, never a fresh start. */
export class PrismaProbeLog {
  constructor(private readonly db: any, private readonly projectId: string, private readonly timeoutMs: number) {}

  async last(): Promise<PhaseRecord | null> {
    const t = this.timeoutMs;
    const row: { details: unknown } | null = await this.db.$transaction((tx: any) => tx.auditEvent.findFirst({
      where: { projectId: this.projectId, action: PHASE_ACTION },
      orderBy: { occurredAt: "desc" },
      select: { details: true },
    }), { timeout: t, maxWait: t });
    if (!row) return null;
    const r = asRecord(row.details);
    if (!r) throw new Error("probe-phase-unreadable");
    return r;
  }

  async record(r: PhaseRecord): Promise<void> {
    const t = this.timeoutMs;
    await this.db.$transaction((tx: any) => tx.auditEvent.create({
      data: { actor: "system", action: PHASE_ACTION, summary: `AT13 probe cycle ${r.cycle}: ${r.phase}${r.result ? ` (${r.result.code})` : ""}`, details: r, projectId: this.projectId },
    }), { timeout: t, maxWait: t });
  }
}

/** The runner's stop, read structurally (StepError lives in @devos/provision, loaded at run time). */
function stepStop(e: unknown): { code: string; retryable: boolean } {
  const x = e as { name?: unknown; code?: unknown; retryable?: unknown } | null;
  if (x && x.name === "StepError" && typeof x.code === "string") return { code: x.code, retryable: x.retryable === true };
  return { code: "provision-failed", retryable: true };
}

/**
 * One provisioning run for the probe project through the same provisioner as the sweep. A retryable stop is
 * "in progress" (the next tick runs again; PROBE_PHASE_MAX_MS bounds it); any other stop is its fixed code.
 */
export async function probeProvisionOnce(
  pv: { ready(): Promise<string | null>; run(p: { id: string; slug: string; name: string }): Promise<unknown> },
  project: { id: string; slug: string; name: string },
): Promise<RunOutcome> {
  const notReady = await pv.ready();
  if (notReady) return { error: notReady };
  try {
    await pv.run(project);
    return "done";
  } catch (e) {
    const s = stepStop(e);
    return s.retryable ? "in_progress" : { error: s.code };
  }
}
