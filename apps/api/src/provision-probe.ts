// DEVOS-228 (M2.4-d3b, docs/modules/M2.4.md "Part 2"): the AT13 live probe's phase machine.
// One call to `probeStep` advances at most one phase, so each server-agent tick fits its 120 s check limit.
// Every effect is injected (provisioning, inventory, live asserts, purge, the phase log), so the order and
// the outcomes are tested without GitHub or Coolify. Output is fixed codes only: never a provider message.

export const PROBE_SLUG = "devos-probe-m24";
export const PROBE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

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
  result?: { ok: boolean; code: string; detail?: string };
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

function nextPhase(p: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(p) + 1, PHASES.length - 1)] ?? "done";
}

function due(last: PhaseRecord, d: ProbeDeps): boolean {
  if (last.fingerprint !== d.fingerprint) return true;
  return d.now().getTime() - Date.parse(last.at) >= PROBE_EVERY_MS;
}

export async function probeStep(d: ProbeDeps): Promise<ProbeTick> {
  const off = await d.offReason();
  if (off) return { exit: 3, phase: "idle", cycle: 0, code: "skipped", detail: off };
  let last = await d.last();
  const at = () => d.now().toISOString();

  if (!last || (last.phase === "done" && due(last, d))) {
    const cycle = (last?.cycle ?? 0) + 1;
    last = { cycle, phase: "run1", at: at(), fingerprint: d.fingerprint };
    await d.record(last);
  } else if (last.phase === "done") {
    // Reported once when it finished; later ticks are skipped until the next cycle is due.
    return { exit: 3, phase: "done", cycle: last.cycle, code: "probed", detail: last.result?.code };
  }

  const { cycle, phase } = last;
  const finish = async (ok: boolean, code: string, detail?: string): Promise<ProbeTick> => {
    await d.record({ ...last!, phase: "done", at: at(), result: { ok, code, detail } });
    return { exit: ok ? 0 : 1, phase: "done", cycle, code, detail };
  };
  const advance = async (extra: Partial<PhaseRecord> = {}): Promise<ProbeTick> => {
    const to = nextPhase(phase);
    await d.record({ ...last!, ...extra, phase: to, at: at() });
    return { exit: 3, phase: to, cycle, code: "in_progress" };
  };

  switch (phase) {
    case "run1":
    case "run2": {
      const r = await d.provisionOnce();
      if (r === "in_progress") return { exit: 3, phase, cycle, code: "in_progress" };
      if (r !== "done") {
        // Purge whatever the failed run created, then report the run's failure (kept in the record).
        await d.record({ ...last, phase: "purge", at: at(), result: { ok: false, code: `${phase}-failed`, detail: r.error } });
        return { exit: 3, phase: "purge", cycle, code: "in_progress" };
      }
      return advance();
    }
    case "inventory1":
      return advance({ inventory1: await d.inventory() });
    case "inventory2": {
      const diff = inventoryDiff(last.inventory1 ?? [], await d.inventory());
      // A failed compare still purges the probe's resources: the failure is kept in the record.
      if (diff) return advance({ result: { ok: false, code: "inventory-differs", detail: diff } });
      return advance();
    }
    case "assert": {
      if (last.result && !last.result.ok) return advance();
      const failed = await d.liveAsserts();
      if (failed.length) return advance({ result: { ok: false, code: "live-assert-failed", detail: failed.join(",") } });
      return advance();
    }
    case "purge": {
      const p = await d.purge();
      if (p === "in_progress") return { exit: 3, phase, cycle, code: "in_progress" };
      if (p !== "done") return finish(false, "purge-failed", p.error);
      if (last.result && !last.result.ok) return finish(false, last.result.code, last.result.detail);
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
