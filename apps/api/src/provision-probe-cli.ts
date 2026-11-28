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
import { probeStep, probeProvisionOnce, ensureProbeProject, PrismaProbeLog, PROBE_CARD_RAISE_GRANT_MS, PROBE_SLUG, type PhaseRecord, type ProbeDeps } from "./provision-probe.js";
import { probeCredentialsUpdatedAt, probeFingerprint, readProbeInventory } from "./provision-probe-cli-parts.js";
import { liveAssertsFor } from "./provision-probe-asserts.js";
import { cycleStartWithCard, findProbeGrant, grantAuthorizer, probeCardCycle, bindProbeCycleCard, probeCardOutcome, probeCycleCard, probeExistingCard, probeGrantOutlasts, probeCycleStart, probePurge, probeStage, raiseProbeGrantCard, raiseProbePurgeCard, archiveUnderProbeGrant, expireProbePurgeCards, probeActiveCounts, teardownWiring, PROBE_GRANT_ACTIONS } from "./provision-probe-purge.js";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

/** A thrown error's message only when it is one of our fixed codes; anything else (a provider or DB text) is hidden. */
export function errorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  return /^(probe|provision)-[a-z0-9-]{1,60}$/.test(m) ? m : "probe-error";
}

/**
 * Pre-review 2: a `detail` is printed only in the shape of our codes and step keys (it can be a runner StepError code
 * read structurally, or come back from a DB row); anything else is replaced, never printed.
 */
export function safeDetail(d: unknown): string | undefined {
  if (d === undefined || d === null || d === "") return undefined;
  return typeof d === "string" && /^[A-Za-z0-9_:.,\/-]{1,120}$/.test(d) ? d : "probe-detail-hidden";
}
const withDetail = (d: unknown) => { const x = safeDetail(d); return x ? { detail: x } : {}; };
/** DEVOS-21 diagnostics: the earlier failure behind a failed purge, in the same safe shape as `detail`. */
const withCause = (c: unknown, cd: unknown) => {
  const x = safeDetail(c);
  if (!x) return {};
  const y = safeDetail(cd);
  return y ? { cause: x, causeDetail: y } : { cause: x };
};
const summary = (r: PhaseRecord) => ({ cycle: r.cycle, phase: r.phase, at: r.at, ...(r.result ? { result: { ok: r.result.ok, code: r.result.code, ...withDetail(r.result.detail), ...withCause(r.result.cause, r.result.causeDetail) } } : {}) });

export const USAGE = "provision-probe-cli.js status|report|step";
/** The command, or null for wrong arguments (exit 2, checked before anything is built or read). */
export function parseCommand(argv: string[]): "status" | "report" | "step" | null {
  return argv.length === 1 && (argv[0] === "status" || argv[0] === "report" || argv[0] === "step") ? argv[0] : null;
}

/**
 * Pre-review 1: the probe is skipped exactly when the sweep would not run: the wiring is off, or a provider token is
 * not in the vault yet (`ready()`, as ProvisionSweepJob checks it). Checked before the probe project is touched.
 */
export async function offReasonFor(w: { off: string } | { provisioner: { ready(): Promise<string | null> } }): Promise<string | null> {
  if ("off" in w) return w.off;
  try {
    return await w.provisioner.ready();
  } catch {
    return "provision-ready-check-failed";
  }
}

/**
 * The CLI's core over injected effects, so it is tested without a database or providers. `deps` is built lazily:
 * `status` and `report` need only the phase log; `step` builds everything (and may report the probe as skipped).
 */
export async function probeCli(argv: string[], deps: { log(): Promise<Pick<ProbeDeps, "last">>; step(): Promise<ProbeDeps> }): Promise<CliResult> {
  const cmd = parseCommand(argv);
  if (!cmd) return { code: 2, out: { error: "usage", usage: USAGE } };
  try {
    if (cmd === "step") {
      const t = await probeStep(await deps.step());
      return { code: t.exit, out: { command: "step", exit: t.exit, phase: t.phase, cycle: t.cycle, code: t.code, ...withDetail(t.detail), ...withCause(t.cause, t.causeDetail) } };
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

/** The effects of a probe that is off: never called (probeStep stops at `offReason`), so they throw a fixed code. */
const notWired = async (): Promise<never> => { throw new Error("probe-not-wired"); };

/**
 * DEVOS-110: the M2.3 core the probe raises its grant card through, with the M1.6 notice wired as runtime.ts wires it.
 * It never approves anything: no KK session verifies, and the grant issuer is not wired.
 */
async function probeApprovals(db: any, vault: { reveal(n: string): Promise<string | null>; list(): Promise<{ name: string; set: boolean }[]> }, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const [{ Approvals, PrismaApprovalStore }, { Notifier, PrismaNotificationStore, parseDashboardUrl }, { parseSmtpConfig }] = await Promise.all([
    import("./approvals.js"), import("./notify.js"), import("./smtp.js"),
  ]);
  const notifier = new Notifier(new PrismaNotificationStore(db, timeoutMs), {
    secrets: { reveal: (name) => vault.reveal(name), isSet: async (name) => (await vault.list()).some((m) => m.name === name && m.set) },
    smtp: parseSmtpConfig(env),
    dashboardUrl: parseDashboardUrl(env.DEVOS_DASHBOARD_URL),
    timeoutMs,
  });
  return new Approvals({
    store: new PrismaApprovalStore(db, timeoutMs),
    grants: { issueGrant: notWired, revokeGrant: notWired },
    notifier,
    verifyKkSession: () => false,
  });
}

// The production wiring; its pieces are tested on their own (probeCli, the parts, offReasonFor, stepWiring, buildProvisioner).
async function main(env: NodeJS.ProcessEnv): Promise<CliResult> {
  const timeoutMs = 10_000;
  const argv = process.argv.slice(2);
  const cmd = parseCommand(argv);
  if (!cmd) return { code: 2, out: { error: "usage", usage: USAGE } };
  const databaseUrl = env.DATABASE_URL;
  // DevOS not deployed with a database here: every command reports skipped (exit 3), with its name.
  if (!databaseUrl) return { code: 3, out: { command: cmd, code: "skipped", detail: "database-not-configured" } };
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => any };
  const db = createDb(databaseUrl);
  try {
    const project = async () => ensureProbeProject(db, new Date(), timeoutMs);
    return await probeCli(argv, {
      log: async () => {
        const found = await db.$transaction((tx: any) => tx.project.findUnique({ where: { slug: PROBE_SLUG }, select: { id: true } }), { timeout: timeoutMs, maxWait: timeoutMs });
        return found ? new PrismaProbeLog(db, found.id, timeoutMs) : { last: async () => null };
      },
      step: async () => {
        const { stepWiring } = await import("./provision-probe-wiring.js");
        const w = await stepWiring(db, databaseUrl, env, timeoutMs);
        // Off (no policy key, vault, provisioning settings or provider token): skipped before the probe project is
        // created or read.
        const off = await offReasonFor(w);
        if (off || "off" in w) {
          const reason = off ?? "provision-off";
          return { offReason: async () => reason, last: async () => null, record: notWired, provisionOnce: notWired, inventory: notWired, liveAsserts: notWired, purge: notWired, fingerprint: "", now: () => new Date() };
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
          inventory: async () => {
            const provisionModuleName = "@devos/provision";
            const { isJournalOnlyKind } = (await import(provisionModuleName)) as { isJournalOnlyKind: (provider: string, kind: string) => boolean };
            return readProbeInventory(db, p.id, timeoutMs, isJournalOnlyKind);
          },
          // d3c-2b: AT13's live asserts over the recorded ids, on the purge kit's clients (decision 1).
          liveAsserts: liveAssertsFor(w.purge, db, p.id, timeoutMs),
          // d3c-2a: the purge through M2.5 under the KK grant (decisions 1–5), found read-only on each use.
          purge: async () => {
            const k = w.purge;
            return probePurge(p.id, {
              teardown: k.teardownMod,
              store: k.store,
              // Pre-review 4: an archived row needs only the purge's use. Codex PR239-r34: the grant is chosen for the
              // stage probePurge itself reads, the read that decides whether to Archive first.
              authorizeFor: async (stage) => {
                const grant = await findProbeGrant(db, p.id, new Date(), timeoutMs, k.grantProblem, stage === "archived" ? ["teardown.purge"] : PROBE_GRANT_ACTIONS);
                return grant ? grantAuthorizer(k.policy, p.id, grant) : null;
              },
              stage: () => probeStage(db, p.id, timeoutMs),
              wiring: () => teardownWiring(k.provisionMod, k.teardownMod, { gh: k.gh, cf: k.cf, store: k.store, db, projectId: p.id, owner: k.owner, timeoutMs }),
            });
          },
          // DEVOS-110: a cycle blocked for want of the grant raises the fixed grant card for KK (at most one open).
          cycleStart: () => cycleStartWithCard(
            () => probeCycleStart(
              db, p.id, timeoutMs,
              async () => (await findProbeGrant(db, p.id, new Date(), timeoutMs, w.purge.grantProblem)) !== null,
              // Codex PR239-r19 (high): the cleanup is authorized only if the active policy would use the grant.
              () => w.purge.policyGated(p.id),
            ),
            async () => {
              const approvals = await probeApprovals(db, w.vault, env, timeoutMs);
              return raiseProbeGrantCard(p.id, new Date(), { list: (f) => approvals.store.list(f), raise: (c) => approvals.raiseCard(c) });
            },
          ),
          // DEVOS-254 (AT10): one cycle purges through KK's gate-5 purge card and the sweep job, not the probe grant.
          cardCycle: () => probeCardCycle(db, p.id, timeoutMs),
          raisePurgeCard: async (cycleFrom, cycle) => {
            const k = w.purge;
            const approvals = await probeApprovals(db, w.vault, env, timeoutMs);
            return raiseProbePurgeCard(p.id, {
              stage: () => probeStage(db, p.id, timeoutMs),
              archivedAt: async () => (await db.$transaction((tx: any) => tx.project.findUnique({ where: { id: p.id }, select: { archivedAt: true } }), { timeout: timeoutMs, maxWait: timeoutMs }))?.archivedAt ?? null,
              // Decision 3: the probe grant covers the archive only; the purge needs KK's card.
              existing: (since) => probeExistingCard(db, p.id, since, timeoutMs),
              // M2.5-b5e decision 21 (Codex PR244-r6): the cycle's one card, bound by id, never found by a time window.
              cycleCard: () => probeCycleCard(db, p.id, cycle, timeoutMs),
              bind: (cardId) => bindProbeCycleCard(db, p.id, cycle, cardId, timeoutMs),
              archive: () => archiveUnderProbeGrant({
                findGrant: (actions) => findProbeGrant(db, p.id, new Date(), timeoutMs, k.grantProblem, actions),
                archive: async (grant) => {
                  const wr = await teardownWiring(k.provisionMod, k.teardownMod, { gh: k.gh, cf: k.cf, store: k.store, db, projectId: p.id, owner: k.owner, timeoutMs });
                  await k.teardownMod.archiveProject(p.id, { store: k.store, authorize: grantAuthorizer(k.policy, p.id, grant), ops: wr.ops });
                },
              }),
              counts: () => probeActiveCounts(db, p.id, timeoutMs),
              // Decision 31 (Codex PR239-r33): the card is written under the lifecycle lock, bound to this archive.
              // Decision 34 (Codex PR239-r36): the cycle's card is reused under the lock, never doubled.
              raise: (c, archivedAt, reuseSince) => approvals.raiseGuardedCard(c, { projectId: p.id, archivedAt, due: false, bindCycle: cycle, ...(reuseSince ? { reuseSince } : {}) }),
              // Codex PR239-r7/r8 (decision 11): only before a new card, from this tick.
              outlasts: () => probeGrantOutlasts(db, p.id, new Date(Date.now() + PROBE_CARD_RAISE_GRANT_MS), timeoutMs, k.grantProblem),
              // Codex PR239-r15: an earlier archive's pending card is expired before the raise, so dedupe never returns it.
              expireStale: (before) => expireProbePurgeCards(db, p.id, timeoutMs, (ids, reason) => approvals.expireCardsById(ids, reason), before),
            }, cycleFrom);
          },
          cardOutcome: (cardId) => probeCardOutcome(db, p.id, cardId, timeoutMs),
          // Codex PR239-r28: the current archive's oldest purge card, for a purge reached without a tracked card.
          archiveCardId: async () => {
            const row = await db.$transaction((tx: any) => tx.project.findUnique({ where: { id: p.id }, select: { archivedAt: true } }), { timeout: timeoutMs, maxWait: timeoutMs });
            return row?.archivedAt instanceof Date ? probeExistingCard(db, p.id, row.archivedAt, timeoutMs) : null;
          },
          // Codex PR239-r7 (decision 11): the probe grant must outlast the card wait, so the fallback purge can run.
          cardGrantOutlasts: (until) => probeGrantOutlasts(db, p.id, until, timeoutMs, w.purge.grantProblem),
          // Codex PR239-r15: before the probe's own purge after a card, its pending purge cards are expired.
          expirePurgeCards: async () => {
            const approvals = await probeApprovals(db, w.vault, env, timeoutMs);
            await expireProbePurgeCards(db, p.id, timeoutMs, (ids, reason) => approvals.expireCardsById(ids, reason));
          },
          // DEVOS-21: a failed cycle re-runs once KK saves a new provider token (metadata read only).
          credentialsUpdatedAt: () => probeCredentialsUpdatedAt(w.vault),
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
    // Codex PR167-r2: exit once the line is written, so a provider read cut off by a budget (still retrying in the
    // background) never keeps the process past the agent's check limit.
    (r) => { process.stdout.write(`${JSON.stringify(r.out)}\n`, () => process.exit(r.code)); },
    (e) => { process.stdout.write(`${JSON.stringify({ error: errorCode(e) })}\n`, () => process.exit(1)); },
  );
}
