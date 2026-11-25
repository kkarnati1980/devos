// DEVOS-112 (M2.5-b1 decision 8, docs/modules/M2.5.md "DEVOS-112: KK's teardown rules check"): the read-only half of
// the server check `scripts/server/checks/teardown-kk-rules.sh`. It answers the open M2.5-b1 question "would M1.7 let
// KK's own Archive and Restore through?" on the real server's policy, without making a decision or writing a receipt:
// it loads the policy in force (mode + enabled rules, `PrismaPolicyStore.loadPolicy`) and runs the pure evaluator
// (`evaluateRules`) for a KK identity on `teardown.archive` and `teardown.restore` against `project:<check sentinel>`.
// Started as `docker exec … node deploy/with-db-url.mjs node apps/api/dist/teardown-rules-cli.js kk-teardown`.
// Prints one JSON line and exits 0 (both allowed), 1 (one is not allowed, or a read failed), 2 (usage) or 3 (no
// database here). It never prints a secret or a database message: errors are fixed codes, rule ids are uuids.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { currentRules, evaluateRules, ruleMatches, wildcard, type PolicyMode, type PolicyRule } from "@devos/policy";

export interface CliResult { code: 0 | 1 | 2 | 3; out: Record<string, unknown> }

export const USAGE = "teardown-rules-cli.js kk-teardown";
/** KK's archive and restore actions (M2.5-b1 routes, `kkAuthorizer`). */
export const KK_TEARDOWN_ACTIONS = ["teardown.archive", "teardown.restore"] as const;
/**
 * The identities and projects the check asks about. A KK session's id is `kk:<tailscale login>` (auth.ts); the check
 * has no login, so it asks as a generic KK principal: rules written for `kk:*` (the M2.5-b1 question) match it, and a
 * rule pinned to one login does not. Codex PR238-r1: the sentinels are fresh random values on every run, two of them,
 * so no rule can be written to match the check's own sentinel and not a real login or project, and both must get the
 * same answer (a rule that matches only one of them is counted as pinned and makes the check fail).
 * Codex PR238-r2: a rule that matches through a narrow pattern (anything but `*`, empty, or a trailing-star prefix of
 * `kk:` / `project:`, e.g. `kk:a*`) could match a random sentinel by chance and miss KK's real login, so such a match
 * is never judged: the action fails with `narrow-match`.
 */
export interface Sentinel { identity: { id: string; type: "kk" }; projectId: string }
export const randomSentinels = (): [Sentinel, Sentinel] => [0, 1].map(() => ({
  identity: { id: `kk:${randomUUID()}`, type: "kk" as const },
  projectId: randomUUID(),
})) as [Sentinel, Sentinel];
const RULE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Reasons the evaluator returns, reduced to their fixed part (a rule id is kept only in `matched`). */
const reasonCode = (reason: string) => reason.split(";").map((p) => p.split(":")[0] ?? "").filter((p) => /^[a-z-]{1,40}$/.test(p)).join(";");

/** Every value starting with `prefix` is matched by this pattern list (empty = any). */
export const genericFor = (patterns: readonly string[], prefix: string) =>
  !patterns.length || patterns.some((p) => p === "*" || (p.endsWith("*") && prefix.startsWith(p.slice(0, -1))));

/** A pattern list that could match some value starting with `prefix` (empty = any). */
const couldMatch = (patterns: readonly string[], prefix: string) =>
  !patterns.length || patterns.some((p) => p.startsWith(prefix) || (p.endsWith("*") && prefix.startsWith(p.slice(0, -1))));

type Req = Parameters<typeof ruleMatches>[1];
const ORDER = { allow: 0, require_approval: 1, deny: 2 } as const;
type Effect = keyof typeof ORDER;
const worst = (x: Effect, y: Effect): Effect => (ORDER[x] >= ORDER[y] ? x : y);

/**
 * Pre-review 2: rules in force for KK's teardown actions that could apply to some KK login and some project but do not
 * match both of the check's requests (pinned to a login or a project, or to a role, environment or constraint). The
 * check cannot judge them, so it counts them for the report.
 */
export function pinnedRules(rules: readonly PolicyRule[], requests: readonly ((type: string) => Req)[]): number {
  return currentRules(rules).filter((r) => KK_TEARDOWN_ACTIONS.some((type) => wildcard(r.actions, type)
    && couldMatch(r.principals, "kk:") && couldMatch(r.resources, "project:") && !requests.every((q) => ruleMatches(r, q(type))))).length;
}

export interface PolicyReader { loadPolicy(): Promise<{ mode: PolicyMode; rules: PolicyRule[] }> }

export async function kkTeardownCli(
  argv: string[],
  reader: () => Promise<PolicyReader>,
  now: () => number = Date.now,
  sentinels: () => [Sentinel, Sentinel] = randomSentinels,
): Promise<CliResult> {
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
  const requests = sentinels().map((x) => (type: string): Req => ({ identity: x.identity, action: { type, resource: `project:${x.projectId}`, projectId: x.projectId } }));
  const actions: Record<string, unknown> = {};
  let allowed = true;
  for (const type of KK_TEARDOWN_ACTIONS) {
    const evs = requests.map((q) => evaluateRules(q(type), policy.rules, policy.mode, now()));
    // The answer reported is the strictest of the two requests; they must agree for a pass.
    const enforced = evs.map((e) => e.enforcedOutcome as Effect).reduce(worst);
    const outcome = evs.map((e) => e.outcome as Effect).reduce(worst);
    const agree = evs.every((e) => e.enforcedOutcome === evs[0]!.enforcedOutcome && e.outcome === evs[0]!.outcome);
    const narrow = currentRules(policy.rules).some((r) => requests.some((q) => ruleMatches(r, q(type)))
      && !(genericFor(r.principals, "kk:") && genericFor(r.resources, "project:")));
    if (enforced !== "allow" || !agree || narrow) allowed = false;
    const reasons = [...new Set(evs.map((e) => reasonCode(e.reason)))];
    actions[type] = {
      outcome,
      enforced,
      reason: narrow ? "narrow-match" : agree ? reasons.join(";") || "none" : "sentinels-disagree",
      matched: [...new Set(evs.flatMap((e) => e.matchedRuleIds))].filter((id) => RULE_ID_RE.test(id)).slice(0, 10),
    };
  }
  return { code: allowed ? 0 : 1, out: { result: allowed ? "pass" : "fail", mode: policy.mode, rules: policy.rules.length, pinned: pinnedRules(policy.rules, requests), actions } };
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
