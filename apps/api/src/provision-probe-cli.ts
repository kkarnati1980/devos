// DEVOS-234 (M2.4-d3c-1, docs/modules/M2.4.md "M2.4-d3c decisions"): the AT13 provisioning probe CLI. Runs inside the
// deployed API container, started by `scripts/server/checks/provision-probe.sh` (d3c-3) through
// `docker exec … node deploy/with-db-url.mjs node apps/api/dist/provision-probe-cli.js <command>`.
// It prints one JSON line and exits 0 pass, 1 fail, 3 skipped / in progress, 2 usage. It never prints a secret or a
// provider message: errors are reduced to a fixed code.
//
// Commands:
//   status   the probe's newest phase record (read-only)
//   report   the newest finished cycle's result: 0 ok, 1 failed, 3 none yet or still running (read-only)
//   step     advance the probe by one phase (probeStep)
import { fileURLToPath } from "node:url";
import { probeStep, probeProvisionOnce, ensureProbeProject, PrismaProbeLog, PROBE_SLUG, type PhaseRecord, type ProbeDeps } from "./provision-probe.js";
import { probeFingerprint, readProbeInventory } from "./provision-probe-cli-parts.js";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

/** A thrown error's message only when it is one of our fixed codes; anything else (a provider or DB text) is hidden. */
export function errorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  return /^(probe|provision)-[a-z0-9-]{1,60}$/.test(m) ? m : "probe-error";
}

const summary = (r: PhaseRecord) => ({ cycle: r.cycle, phase: r.phase, at: r.at, ...(r.result ? { result: { ok: r.result.ok, code: r.result.code, ...(r.result.detail ? { detail: r.result.detail } : {}) } } : {}) });

/**
 * The CLI's core over injected effects, so it is tested without a database or providers. `deps` is built lazily:
 * `status` and `report` need only the phase log; `step` builds everything (and may report the probe as skipped).
 */
export async function probeCli(argv: string[], deps: { log(): Promise<Pick<ProbeDeps, "last">>; step(): Promise<ProbeDeps> }): Promise<CliResult> {
  const cmd = argv[0];
  if (argv.length !== 1 || !["status", "report", "step"].includes(cmd ?? "")) {
    return { code: 2, out: { error: "usage", usage: "provision-probe-cli.js status|report|step" } };
  }
  try {
    if (cmd === "step") {
      const t = await probeStep(await deps.step());
      return { code: t.exit, out: { command: "step", ...t } };
    }
    const last = await (await deps.log()).last();
    if (cmd === "status") return { code: 0, out: { command: "status", ...(last ? summary(last) : { phase: "idle", cycle: 0 }) } };
    if (!last) return { code: 3, out: { command: "report", code: "no-cycle" } };
    if (last.phase !== "done" || !last.result) return { code: 3, out: { command: "report", code: "in_progress", ...summary(last) } };
    return { code: last.result.ok ? 0 : 1, out: { command: "report", code: last.result.code, ...summary(last) } };
  } catch (e) {
    return { code: 1, out: { command: cmd, error: errorCode(e) } };
  }
}

/** d3c-1: the live asserts and the purge are wired in d3c-2. Until then they throw a fixed code (see the contract). */
const notWired = async (): Promise<never> => { throw new Error("probe-not-wired"); };

/* c8 ignore start -- the production wiring; its pieces are tested on their own (probeCli, the parts, buildProvisioner). */
async function main(env: NodeJS.ProcessEnv): Promise<CliResult> {
  const timeoutMs = 10_000;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return { code: 3, out: { code: "skipped", detail: "database-not-configured" } };
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => any };
  const db = createDb(databaseUrl);
  try {
    const project = async () => ensureProbeProject(db, new Date(), timeoutMs);
    return await probeCli(process.argv.slice(2), {
      log: async () => {
        const found = await db.project.findUnique({ where: { slug: PROBE_SLUG }, select: { id: true } });
        return found ? new PrismaProbeLog(db, found.id, timeoutMs) : { last: async () => null };
      },
      step: async () => {
        const { stepWiring } = await import("./provision-probe-wiring.js");
        const w = await stepWiring(db, databaseUrl, env, timeoutMs);
        // Off (no policy key, vault or provisioning settings): skipped before the probe project is created or read.
        if ("off" in w) {
          const off = w.off;
          return { offReason: async () => off, last: async () => null, record: notWired, provisionOnce: notWired, inventory: notWired, liveAsserts: notWired, purge: notWired, fingerprint: "", now: () => new Date() };
        }
        const pv = w.provisioner;
        const p = await project();
        const log = new PrismaProbeLog(db, p.id, timeoutMs);
        const root = new URL("../../../", import.meta.url);
        return {
          offReason: async () => null,
          last: () => log.last(),
          record: (r) => log.record(r),
          provisionOnce: () => probeProvisionOnce(pv, p),
          inventory: () => readProbeInventory(db, p.id),
          liveAsserts: notWired,
          purge: notWired,
          fingerprint: await probeFingerprint(fileURLToPath(root)),
          now: () => new Date(),
        };
      },
    });
  } finally {
    await db.$disconnect?.().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).then(
    (r) => { process.stdout.write(`${JSON.stringify(r.out)}\n`); process.exitCode = r.code; },
    (e) => { process.stdout.write(`${JSON.stringify({ error: errorCode(e) })}\n`); process.exitCode = 1; },
  );
}
/* c8 ignore stop */
