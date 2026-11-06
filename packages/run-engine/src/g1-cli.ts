// DevOS G1 server-check helper (R2-a, docs/modules/R2.md). Runs inside the deployed worker container,
// started by the `scripts/server/checks/*.sh` checks through `docker exec … node deploy/with-db-url.mjs`.
// It prints one JSON line and exits 0 pass, 1 fail, 3 skipped, 2 usage. It never prints a secret or a
// configuration value: errors are reduced to a code.
//
// Commands:
//   caps                  the wizard's caps are confirmed and positive (read-only)
//   receipts              every policy receipt chain verifies with the server's HMAC key (read-only)
//   probe-start           queue one probe run in the dedicated `g1-probe` project (no provider, no spend)
//   probe-guard <runId>   the worker may be killed now: it holds only the probe (read-only)
//   probe-status <runId>  the probe run's resume and money evidence (read-only)
import { fileURLToPath } from "node:url";
import { PolicyEngine, PrismaPolicyStore, type PrismaLike as PolicyPrismaLike } from "@devos/policy";
import { PROBE_MODEL, PROBE_TURNS } from "./probe-adapter.js";
import { MIN_HMAC_KEY_BYTES } from "./worker-main.js";

export const PASS = 0;
export const FAIL = 1;
export const SKIP = 3;

export const PROBE_SLUG = "g1-probe";
/** The probe run's ceilings: far above what it records (4 × 1 µUSD), far below anything real. */
export const PROBE_MAX_COST_USD = 0.01;
export const PROBE_MAX_SECONDS = 300;
export const PROBE_RESERVE_TOKENS = 1_000;
/**
 * USD reserved per attempt. A hard-killed attempt is charged its whole reservation on recovery (M1.5
 * fail-closed rule 9), so this is kept at a tenth of max_cost_usd: the resumed attempt still fits.
 */
export const PROBE_RESERVE_USD = 0.001;
/** An unfinished probe run older than this is stale (its job was lost): it is closed as failed. */
export const PROBE_STALE_MS = 15 * 60_000;

export interface Verdict {
  /** 0 pass, 1 fail, 2 usage, 3 skipped (or still running, for probe-status). */
  code: 0 | 1 | 2 | 3;
  out: Record<string, unknown>;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const ok = (out: Record<string, unknown>): Verdict => ({ code: PASS, out: { result: "pass", ...out } });
const fail = (reason: string, out: Record<string, unknown> = {}): Verdict => ({ code: FAIL, out: { result: "fail", reason, ...out } });
const skip = (reason: string, out: Record<string, unknown> = {}): Verdict => ({ code: SKIP, out: { result: "skipped", reason, ...out } });

// Minimal Prisma surface used here (tests pass a fake).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Db = any;

/** caps-saved: skipped until H9 (no row, or caps never confirmed in the wizard). */
export async function checkCaps(db: Db): Promise<Verdict> {
  const s = await db.appSettings.findFirst({ where: { singleton: true } });
  if (!s) return skip("no-app-settings");
  if (!s.capsConfirmedAt) return skip("caps-not-confirmed");
  const caps = { anthropicCapUsd: num(s.anthropicCapUsd), openaiCapUsd: num(s.openaiCapUsd), defaultProjectCapUsd: num(s.defaultProjectCapUsd) };
  const bad = Object.entries(caps).filter(([, v]) => !Number.isFinite(v) || v <= 0).map(([k]) => k);
  const confirmedAt = new Date(s.capsConfirmedAt).toISOString();
  if (bad.length > 0) return fail("cap-not-positive", { fields: bad, confirmedAt });
  return ok({ ...caps, confirmedAt });
}

/** receipt-chain: every chain verifies; skipped while there are no receipts. */
export async function checkReceipts(db: Db, verify: (chain: string) => Promise<{ valid: boolean; length: number; error?: string; at?: number }>): Promise<Verdict> {
  const groups: { chain: string }[] = await db.policyDecision.groupBy({ by: ["chain"], orderBy: { chain: "asc" } });
  if (groups.length === 0) return skip("no-receipts");
  const chains: Record<string, unknown>[] = [];
  let total = 0;
  for (const { chain } of groups) {
    const v = await verify(chain);
    total += v.length;
    chains.push({ chain, length: v.length, valid: v.valid, ...(v.valid ? {} : { error: v.error, at: v.at }) });
    if (!v.valid) return fail(v.error ?? "receipt-chain-invalid", { chains });
  }
  return ok({ chains, receipts: total });
}

/** Find or create the probe project and its task (only rows of the `g1-probe` project are written). */
async function probeProject(db: Db): Promise<{ projectId: string; taskId: string; pausedAt: Date | null }> {
  const project =
    (await db.project.findUnique({ where: { slug: PROBE_SLUG } })) ??
    (await db.project.create({ data: { slug: PROBE_SLUG, name: "G1 probe (server check, no spend)", capUsd: PROBE_MAX_COST_USD * 10, lanes: 1 } }));
  const task =
    (await db.task.findFirst({ where: { projectId: project.id, title: "g1-probe run-resume" } })) ??
    (await db.task.create({ data: { projectId: project.id, kind: "test", title: "g1-probe run-resume" } }));
  return { projectId: project.id, taskId: task.id, pausedAt: project.pausedAt ?? null };
}

/**
 * probe-start: refuses while any other run is queued or running, or a recent probe run is unfinished.
 * Creates one run and queues it. PR21-r1: a probe run whose job never reached the queue is closed as
 * failed at once (enqueue error) or once stale, so a lost job never blocks later checks.
 */
export async function probeStart(
  db: Db,
  enqueue: (input: { runId: string; provider: "anthropic"; prompt: string; cwd: string; reserveTokens: number; reserveUsd: number }) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<Verdict> {
  const { projectId, taskId, pausedAt } = await probeProject(db);
  if (pausedAt) return fail("probe-project-paused", { projectId });
  const busy = await db.run.count({ where: { status: { in: ["queued", "running"] }, projectId: { not: projectId } } });
  if (busy > 0) return skip("worker-busy", { activeRuns: busy });
  const stale = await db.run.updateMany({
    where: { projectId, status: { in: ["queued", "running"] }, createdAt: { lt: new Date(now() - PROBE_STALE_MS) } },
    data: { status: "failed", error: "probe-stale", endedAt: new Date(now()) },
  });
  const open = await db.run.count({ where: { status: { in: ["queued", "running"] }, projectId } });
  if (open > 0) return fail("probe-run-unfinished", { openProbeRuns: open });
  const run = await db.run.create({
    data: { taskId, projectId, role: "tester", model: PROBE_MODEL, maxTurns: PROBE_TURNS + 6, maxSeconds: PROBE_MAX_SECONDS, maxCostUsd: PROBE_MAX_COST_USD },
  });
  try {
    await enqueue({ runId: run.id, provider: "anthropic", prompt: "g1 probe", cwd: "/tmp", reserveTokens: PROBE_RESERVE_TOKENS, reserveUsd: PROBE_RESERVE_USD });
  } catch (e) {
    // The job may or may not have reached Redis; a run nobody will execute must not stay open. If the
    // job did arrive, the engine sees a finished run and does not start it again (M1.5 rule 8).
    await db.run.update({ where: { id: run.id }, data: { status: "failed", error: "probe-enqueue-failed", endedAt: new Date(now()) } });
    return fail("probe-enqueue-failed", { runId: run.id, code: errorCode(e) });
  }
  return ok({ runId: run.id, projectId, ...(stale.count > 0 ? { closedStaleProbeRuns: stale.count } : {}) });
}

/**
 * probe-guard (PR21-r1): the last gate before run-resume.sh kills the worker. Pass only when killing it
 * can cut short nothing but the probe: the worker runs one job at a time, the queue's only active job is
 * the probe, no other project's run is running, and the probe is mid-run with at least one turn left
 * (so its slot stays taken until the kill a moment later). Anything else is skipped: no kill.
 */
export async function probeGuard(db: Db, runId: string, activeJobIds: string[], concurrency: number): Promise<Verdict> {
  if (!UUID.test(runId)) return { code: 2, out: { result: "usage", reason: "run-id-invalid" } };
  if (concurrency !== 1) return skip("worker-concurrency-not-1", { concurrency });
  const others = activeJobIds.filter((id) => id !== runId);
  if (others.length > 0 || !activeJobIds.includes(runId)) return skip("queue-active-not-only-probe", { activeJobs: activeJobIds.length });
  const run = await db.run.findUnique({ where: { id: runId } });
  if (!run || run.model !== PROBE_MODEL) return fail("probe-run-not-found");
  const project = await db.project.findUnique({ where: { slug: PROBE_SLUG } });
  const running = await db.run.count({ where: { status: "running", projectId: { not: project?.id ?? run.projectId } } });
  if (running > 0) return skip("worker-busy", { activeRuns: running });
  if (run.status !== "running") return skip("probe-not-running", { status: run.status });
  const cps: { data: any }[] = await db.checkpoint.findMany({ where: { runId }, orderBy: { seq: "desc" }, take: 1, select: { data: true } });
  const turn = num(cps[0]?.data?.turn);
  if (turn < 1 || turn > PROBE_TURNS - 2) return skip("probe-turn-out-of-window", { turns: turn });
  return ok({ runId, turns: turn });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * probe-status: the evidence for "a killed run resumes with its reservation reconciled".
 * pass = succeeded, every turn done, a `resumed` status event, gapless event seq, no reservation left
 * open, and money consistent: each closed reservation charged exactly once (sum of cost_entry = sum of
 * reconciled actual_usd) and nothing above the run's max_cost_usd.
 */
export async function probeStatus(db: Db, runId: string, requireResume: boolean): Promise<Verdict> {
  if (!UUID.test(runId)) return { code: 2, out: { result: "usage", reason: "run-id-invalid" } };
  const run = await db.run.findUnique({ where: { id: runId } });
  if (!run || run.model !== PROBE_MODEL) return fail("probe-run-not-found");
  const events: { seq: number; type: string; payload: any }[] = await db.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" }, select: { seq: true, type: true, payload: true } });
  const cps: { data: any }[] = await db.checkpoint.findMany({ where: { runId }, orderBy: { seq: "desc" }, take: 1, select: { data: true } });
  const reservations: { status: string; actualUsd: unknown }[] = await db.budgetReservation.findMany({ where: { runId }, select: { status: true, actualUsd: true } });
  const costs: { usd: unknown }[] = await db.costEntry.findMany({ where: { runId }, select: { usd: true } });

  const turn = num(cps[0]?.data?.turn);
  const gapless = events.every((e, i) => e.seq === i + 1);
  const resumed = events.some((e) => e.type === "status" && e.payload?.state === "resumed");
  const recovered = events.some((e) => e.type === "status" && e.payload?.state === "recovered");
  const openReservations = reservations.filter((r) => r.status === "reserved").length;
  // PR21-r1: money is compared in integer microdollars, exactly (one turn is 1 µUSD).
  const reconciledMicros = reservations.filter((r) => r.status === "reconciled").reduce((a, r) => a + micros(r.actualUsd), 0);
  const costMicros = costs.reduce((a, c) => a + micros(c.usd), 0);
  const maxMicros = micros(run.maxCostUsd);
  const reconciledUsd = reconciledMicros / 1e6;
  const costUsd = costMicros / 1e6;
  const out = {
    runId, status: run.status, turns: turn, events: events.length, gapless, resumed, recovered, reservations: reservations.length, openReservations,
    costEntries: costs.length, costUsd, reconciledUsd, maxCostUsd: num(run.maxCostUsd),
  };
  if (run.status === "queued" || run.status === "running") return { code: SKIP, out: { result: "running", ...out } };
  if (run.status !== "succeeded") return fail(`probe-run-${run.status}`, out);
  if (turn < PROBE_TURNS) return fail("turns-incomplete", out);
  if (!gapless) return fail("event-seq-gap", out);
  if (requireResume && !resumed) return fail("no-resume-event", out);
  if (openReservations > 0) return fail("reservation-open", out);
  if (costs.length === 0) return fail("no-cost-entry", out);
  if (costMicros !== reconciledMicros) return fail("cost-not-reconciled", out);
  if (costMicros > maxMicros) return fail("cost-over-max", out);
  return ok(out);
}

/**
 * Decimal(12,6) USD → integer microdollars, from its decimal string (no float arithmetic). A value with
 * more than 6 decimals, or not a plain decimal, is NaN, which fails every comparison.
 */
export function micros(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(v).trim());
  if (!m) return Number.NaN;
  const n = Number(m[2]) * 1e6 + Number((m[3] ?? "").padEnd(6, "0"));
  return m[1] ? -n : n;
}

/** Reduce any error to a code: never a message (it may carry a URL or a value). */
export function errorCode(e: unknown): string {
  if (e instanceof Error) {
    if (/^(config|queue|probe|receipt)-[a-z0-9-]+$/.test(e.message)) return e.message;
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && /^P\d{4}$/.test(c)) return `prisma-${c}`;
    if (typeof c === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(c)) return `error-${c.toLowerCase()}`;
  }
  return "error";
}

export async function cli(argv: string[], env: NodeJS.ProcessEnv): Promise<Verdict> {
  const [cmd, arg] = argv;
  if (!["caps", "receipts", "probe-start", "probe-guard", "probe-status"].includes(cmd ?? "")) return { code: 2, out: { result: "usage", reason: "unknown-command" } };
  const url = env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(url)) return fail("config-database-url-required");
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (url: string) => Db };
  const db = createDb(url);
  try {
    if (cmd === "caps") return await checkCaps(db);
    if (cmd === "receipts") {
      const key = Buffer.from(env.DEVOS_POLICY_HMAC_KEY ?? "", "utf8");
      if (key.length < MIN_HMAC_KEY_BYTES) return fail("config-policy-hmac-key-too-short");
      const engine = new PolicyEngine({ store: new PrismaPolicyStore(db as PolicyPrismaLike), hmacKey: key });
      return await checkReceipts(db, (chain) => engine.verify(chain));
    }
    if (cmd === "probe-status") return await probeStatus(db, arg ?? "", env.G1_REQUIRE_RESUME !== "0");
    const redisUrl = env.REDIS_URL ?? "";
    if (!/^rediss?:\/\//.test(redisUrl)) return fail("config-redis-url-required");
    const { RunQueue } = await import("./queue.js");
    const queue = new RunQueue({ redisUrl });
    try {
      if (cmd === "probe-guard") {
        const active = await queue.queue.getActive();
        const concurrency = Number(env.DEVOS_WORKER_CONCURRENCY ?? 1);
        return await probeGuard(db, arg ?? "", active.map((j) => String(j.id)), concurrency);
      }
      return await probeStart(db, (input) => queue.enqueue(input));
    } finally {
      await queue.close().catch(() => undefined);
    }
  } catch (e) {
    return fail(errorCode(e));
  } finally {
    await db.$disconnect?.().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2), process.env).then(
    (v) => {
      process.stdout.write(JSON.stringify(v.out) + "\n");
      process.exit(v.code);
    },
    (e: unknown) => {
      process.stdout.write(JSON.stringify({ result: "fail", reason: errorCode(e) }) + "\n");
      process.exit(FAIL);
    },
  );
}
