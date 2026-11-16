// KK's floor-guard answers, read from Linear v1.0.0 (DEVOS-239 part b, contract docs/modules/GI-1e.md).
// Reads the comments on the Linear issue(s) a PR names (its branch `kishore/devos-<n>-…` and `Fixes DEVOS-<n>` lines)
// and parses KK's `FLOOR-GUARD KK KEEP|RESTORE <id> <file>:<line> <full sha>` lines with ./kk-answers.mjs.
// Every failure yields NO records (a KK-only hit then stays refused), never a pass. The key is read by name, sent
// only to api.linear.app, and never logged or put in a message. One read endpoint, a timeout on every call and 60 s
// for the whole read, retries only for this read (ADR-0011, note 0028). Zero dependencies.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKkAnswers, isRunnerText } from "./kk-answers.mjs";

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
/** The env var holding the read-only Linear key (a GitHub Actions secret of the same name in CI). */
export const KEY_ENV = "LINEAR_READ_KEY";
/** KK's own Linear user (workspace kishoremb). Runners post as this user too, so `[runner` still separates them;
 * pinning the author removes every other member, guest or integration (pre-review finding 2). */
export const KK_LINEAR_USER_ID = "b9a2ca4d-b88b-4c7b-8526-fde8045b98f7";
export const MAX_ISSUES = 3;
export const MAX_PAGES = 5;
export const MAX_RECORDS = 200;
const PAGE = 100;

export class KkSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "KkSourceError";
  }
}

/**
 * The DEVOS issue ids a PR names: the branch `kishore/devos-<n>-…` and body lines `Fixes|Closes|Resolves DEVOS-<n>`.
 * Unique, in that order, at most MAX_ISSUES. Naming another issue gains nothing: an answer is bound to the head SHA.
 */
export function issueIdsFor({ branch, body } = {}) {
  const ids = [];
  const add = (n) => { const id = `DEVOS-${Number(n)}`; if (!ids.includes(id)) ids.push(id); };
  const b = /^kishore\/devos-([1-9][0-9]{0,5})(?:-|$)/i.exec(String(branch ?? ""));
  if (b) add(b[1]);
  for (const m of String(body ?? "").matchAll(/^[ \t]*(?:Fixes|Closes|Resolves)[ \t]+DEVOS-([1-9][0-9]{0,5})\b/gim)) add(m[1]);
  return ids.slice(0, MAX_ISSUES);
}

const QUERY = `query KkAnswers($id: String!, $after: String) {
  issue(id: $id) {
    identifier
    comments(first: ${PAGE}, after: $after) {
      nodes { body url botActor { id } user { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GraphQL read, retried on network errors, timeouts, 429 and 5xx (a read is safe to repeat). */
async function linearQuery(variables, { key, fetchImpl, timeoutMs, attempts, sleep, deadline, now }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * 2 ** (i - 1));
    const left = deadline - now();
    if (left <= 0) throw new KkSourceError("Linear did not answer within the time allowed");
    let res;
    try {
      res = await fetchImpl(LINEAR_ENDPOINT, {
        method: "POST",
        headers: { authorization: key, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
      });
    } catch (err) {
      last = new KkSourceError(`Linear ${err?.name === "TimeoutError" ? "timed out" : "request failed"}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) { last = new KkSourceError(`Linear HTTP ${res.status}`); continue; }
    if (res.status !== 200) throw new KkSourceError(`Linear HTTP ${res.status}`);
    // The body is read inside the attempt: a timeout or network failure while it streams is retried like one before
    // the headers (Codex PR162-r1); only a body that arrived whole and is not JSON is refused at once.
    let text;
    try {
      text = await res.text();
    } catch (err) {
      last = new KkSourceError(`Linear ${err?.name === "TimeoutError" ? "timed out" : "request failed"} while sending its answer`);
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new KkSourceError("Linear sent a response that is not JSON"); }
    if (Array.isArray(json?.errors) && json.errors.length) throw new KkSourceError("Linear refused the query");
    return json?.data;
  }
  throw last ?? new KkSourceError("Linear request failed");
}

/**
 * KK's candidate comments ({ body, link }) on the given issues. A comment made by an app or bot (botActor), one by
 * anyone but KK's Linear user, one starting `[runner` or one without an https url is dropped here; kk-answers.mjs checks the last two
 * again. Throws KkSourceError on any failure; the caller turns that into no records.
 */
export async function readKkComments({ ids, key, fetchImpl = fetch, timeoutMs = 15_000, attempts = 3, sleep = realSleep, totalMs = 60_000, now = Date.now }) {
  if (typeof key !== "string" || !key.trim()) throw new KkSourceError(`no Linear key (${KEY_ENV} is not set)`);
  const deadline = now() + totalMs;
  const out = [];
  for (const id of ids) {
    let after = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new KkSourceError(`${id} has more than ${MAX_PAGES * PAGE} comments`);
      const data = await linearQuery({ id, after }, { key: key.trim(), fetchImpl, timeoutMs, attempts, sleep, deadline, now });
      const c = data?.issue?.comments;
      if (!c || !Array.isArray(c.nodes)) throw new KkSourceError(`Linear has no readable comments for ${id}`);
      for (const n of c.nodes) {
        if (!n || typeof n.body !== "string" || n.botActor || n.user?.id !== KK_LINEAR_USER_ID || isRunnerText(n.body)) continue;
        if (typeof n.url !== "string" || !/^https:\/\/linear\.app\/\S+$/.test(n.url)) continue;
        out.push({ body: n.body, link: n.url });
      }
      if (!c.pageInfo?.hasNextPage) break;
      after = c.pageInfo.endCursor;
      if (typeof after !== "string" || !after) throw new KkSourceError(`Linear gave no cursor for ${id}`);
    }
  }
  return out;
}

/**
 * KK's answer records for a PR. Never throws: any failure (no key, no issue named, Linear down or refusing) gives
 * `records: []` and an `error`, so every KK-only hit stays refused.
 * @returns {Promise<{ records: object[], unreadable: string[], issues: string[], error: string|null }>}
 */
export async function kkAnswersForPr({ branch, body, key, ...io }) {
  const issues = issueIdsFor({ branch, body });
  if (!issues.length) return { records: [], unreadable: [], issues, error: "the PR names no DEVOS issue (branch or Fixes line)" };
  try {
    const { records, unreadable } = parseKkAnswers(await readKkComments({ ids: issues, key, ...io }));
    return { records, unreadable, issues, error: null };
  } catch (err) {
    return { records: [], unreadable: [], issues, error: err instanceof KkSourceError ? err.message : "unexpected failure reading Linear" };
  }
}

/** CLI args: `--event <GitHub event file> --out <json file>`. */
export function parseArgs(argv) {
  const out = { event: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--event") out.event = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else throw new KkSourceError(`unknown argument: ${argv[i]}`);
  }
  if (!out.event || !out.out) throw new KkSourceError("usage: kk-source.mjs --event <event.json> --out <answers.json>");
  return out;
}

/**
 * CI entry: reads the PR's branch and body from the event file, writes `{ records, unreadable (a count), issues, error }` to
 * --out and exits 0 whatever Linear says (no answers only keeps hits refused). Exit 2 only for bad arguments or an
 * unwritable output: the kk-answers job then fails and ci-gate (which still runs) gets no answers.
 */
export async function main(argv, { env = process.env, log = console.log, ...io } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (err) { log(`kk-source: ${err.message}`); return 2; }
  let pr = {};
  try { pr = JSON.parse(readFileSync(args.event, "utf8"))?.pull_request ?? {}; } catch { pr = {}; }
  const r = await kkAnswersForPr({ branch: pr?.head?.ref, body: pr?.body, key: env[KEY_ENV], ...io });
  // The file becomes a job output (1 MB limit): records only, plus a count of unreadable lines; more than
  // MAX_RECORDS records gives none (fail closed) (pre-review r2, finding 3).
  const tooMany = r.records.length > MAX_RECORDS;
  const file = { records: tooMany ? [] : r.records, unreadable: r.unreadable.length, issues: r.issues, error: tooMany ? `more than ${MAX_RECORDS} KK answer lines; none used` : r.error };
  try {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(file));
  } catch {
    log("kk-source: cannot write the answers file");
    return 2;
  }
  log(`kk-source: issues ${file.issues.join(", ") || "none"}; ${file.records.length} KK answer(s)${file.unreadable ? `; ${file.unreadable} unreadable FLOOR-GUARD KK line(s)` : ""}${file.error ? `; none read: ${file.error}` : ""}`);
  return 0;
}

/** True when this file is the script node was asked to run, symlinks resolved (pre-review finding 4). */
export function isEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
