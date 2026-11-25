// DEVOS-112 (M2.5-b1 decision 8, docs/modules/M2.5.md "DEVOS-112: KK's teardown rules check"): the read-only half of
// the server check `scripts/server/checks/teardown-kk-rules.sh`. It answers the open M2.5-b1 question "would M1.7 let
// KK's own Archive and Restore through?" on the real server's policy, without making a decision or writing a receipt:
// it loads the policy in force (mode + enabled rules, `PrismaPolicyStore.loadPolicy`) and runs the pure evaluator
// (`evaluateRules`) for a KK identity on `teardown.archive` and `teardown.restore` against `project:<check sentinel>`.
// Started as `docker exec … node deploy/with-db-url.mjs node apps/api/dist/teardown-rules-cli.js kk-teardown`.
// Prints one JSON line and exits 0 (both allowed), 1 (one is not allowed, or a read failed), 2 (usage) or 3 (no
// database here). It never prints a secret or a database message: errors are fixed codes, rule ids are uuids.
import { fileURLToPath } from "node:url";
import { evaluateRules, type PolicyMode, type PolicyRule } from "@devos/policy";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

export const USAGE = "teardown-rules-cli.js kk-teardown";
/** KK's archive and restore actions (M2.5-b1 routes, `kkAuthorizer`). */
export const KK_TEARDOWN_ACTIONS = ["teardown.archive", "teardown.restore"] as const;
/**
 * The identity and project the check asks about. A KK session's id is `kk:<tailscale login>` (auth.ts); the check has
 * no login, so it asks as a generic KK principal: rules written for `kk:*` (the M2.5-b1 question) match it, and a rule
 * pinned to one login does not. A rule pinned to one project's resource does not match the sentinel project either.
 */
export const CHECK_IDENTITY = Object.freeze({ id: "kk:teardown-rules-check", type: "kk" as const });
export const CHECK_PROJECT_ID = "00000000-0000-4000-8000-000000000000";
const RULE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Reasons the evaluator returns, reduced to their fixed part (a rule id is kept only in `matched`). */
const reasonCode = (reason: string) => reason.split(";").map((p) => p.split(":")[0] ?? "").filter((p) => /^[a-z-]{1,40}$/.test(p)).join(";");

export interface PolicyReader { loadPolicy(): Promise<{ mode: PolicyMode; rules: PolicyRule[] }> }

export async function kkTeardownCli(argv: string[], reader: () => Promise<PolicyReader>, now: () => number = Date.now): Promise<CliResult> {
  if (argv.length !== 1 || argv[0] !== "kk-teardown") return { code: 2, out: { error: "usage", usage: USAGE } };
  let policy: { mode: PolicyMode; rules: PolicyRule[] };
  try {
    policy = await (await reader()).loadPolicy();
  } catch {
    return { code: 1, out: { error: "teardown-rules-read-failed" } };
  }
  if (!policy || (policy.mode !== "observe" && policy.mode !== "enforce") || !Array.isArray(policy.rules)) {
    return { code: 1, out: { error: "teardown-rules-read-failed" } };
  }
  const actions: Record<string, unknown> = {};
  let allowed = true;
  for (const type of KK_TEARDOWN_ACTIONS) {
    const ev = evaluateRules(
      { identity: CHECK_IDENTITY, action: { type, resource: `project:${CHECK_PROJECT_ID}`, projectId: CHECK_PROJECT_ID } },
      policy.rules,
      policy.mode,
      now(),
    );
    if (ev.enforcedOutcome !== "allow") allowed = false;
    actions[type] = {
      outcome: ev.outcome,
      enforced: ev.enforcedOutcome,
      reason: reasonCode(ev.reason),
      matched: ev.matchedRuleIds.filter((id) => RULE_ID_RE.test(id)).slice(0, 10),
    };
  }
  return { code: allowed ? 0 : 1, out: { result: allowed ? "pass" : "fail", mode: policy.mode, rules: policy.rules.length, actions } };
}

async function main(env: NodeJS.ProcessEnv): Promise<CliResult> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "kk-teardown") return { code: 2, out: { error: "usage", usage: USAGE } };
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return { code: 3, out: { code: "skipped", detail: "database-not-configured" } };
  const dbModuleName = "@devos/db";
  const { createDb } = (await import(dbModuleName)) as { createDb: (u: string) => any };
  const { PrismaPolicyStore } = await import("@devos/policy");
  const db = createDb(databaseUrl);
  try {
    return await kkTeardownCli(argv, async () => new PrismaPolicyStore(db));
  } finally {
    await db.$disconnect?.().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.env).then(
    (r) => { process.stdout.write(`${JSON.stringify(r.out)}\n`, () => process.exit(r.code)); },
    () => { process.stdout.write(`${JSON.stringify({ error: "teardown-rules-error" })}\n`, () => process.exit(1)); },
  );
}
