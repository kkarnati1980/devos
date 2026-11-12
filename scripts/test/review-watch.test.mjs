// DevOS — review watcher gh_all regression test (DEVOS-113, review-watch v1.1.3, AT14)
// A page bigger than the kernel's 128 KiB per-argument limit must be listed in full, not dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const harness = `set -euo pipefail
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
log(){ echo "$*" >&2; }
gh_api(){ case "$2" in
  *pulls*page=1) jq -nc '[range(100) | {number: ., body: ("x" * 3000)}]';;
  *pulls*page=2) jq -nc '[range(5) | {number: (. + 100), body: "short"}]';;
  *runs*page=1) jq -nc '{workflow_runs: [range(100) | {id: ., pad: ("y" * 2000)}]}';;
  *runs*page=2) jq -nc '{workflow_runs: [range(3) | {id: (. + 100)}]}';;
  esac; }
eval "$(sed -n '/^gh_all() {/,/^}/p' scripts/review/review-watch.sh)"
p="$(gh_all "/repos/x/pulls?state=open" '')"
r="$(gh_all "/repos/x/actions/runs?head_sha=abc" workflow_runs)"
printf '%s %s %s\\n' "$(jq length <<<"$p")" "$(jq length <<<"$r")" "\${#p}"
`;

test("AT14: gh_all lists a page larger than 128 KiB in full (two pages, top-level and keyed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const f = join(dir, "h.sh");
  writeFileSync(f, harness);
  const [prs, runs, bytes] = execFileSync("bash", [f], { cwd: ROOT, encoding: "utf8" }).trim().split(" ").map(Number);
  assert.equal(prs, 105);
  assert.equal(runs, 103);
  assert.ok(bytes > 131072, `first page must exceed 128 KiB, was ${bytes}`);
});

test("AT14: gh_all never passes page data as a jq argument", () => {
  const src = execFileSync("sed", ["-n", "/^gh_all() {/,/^}/p", "scripts/review/review-watch.sh"], { cwd: ROOT, encoding: "utf8" });
  assert.doesNotMatch(src, /--argjson|--arg /);
});

// DEVOS-115 (review-watch v1.2.0): the repo is public; only own-repo PRs by an allowed author are reviewed.
const trustHarness = (authors) => `set -euo pipefail
REPO="kkarnati1980/devos"
${authors === undefined ? "" : `REVIEW_AUTHORS="${authors}"`}
log(){ echo "$*" >&2; }
eval "$(sed -n '/^REVIEW_AUTHORS=/p; /^trusted_pr() {/,/^}/p' scripts/review/review-watch.sh)"
while IFS= read -r pr; do if printf '%s' "$pr" | trusted_pr; then echo yes; else echo no; fi; done
`;
const pr = (login, repo) => JSON.stringify({ number: 1, user: login === null ? null : { login }, head: { sha: "a".repeat(40), repo: repo === null ? null : { full_name: repo } } });
const trust = (authors, prs) => {
  const dir = mkdtempSync(join(tmpdir(), "rw-"));
  const f = join(dir, "t.sh");
  writeFileSync(f, trustHarness(authors));
  return execFileSync("bash", [f], { cwd: ROOT, encoding: "utf8", input: prs.join("\n") + "\n" }).trim().split("\n");
};

test("AT18: only PRs whose head is in kkarnati1980/devos and whose author is allowed are trusted", () => {
  const got = trust(undefined, [
    pr("kkarnati1980", "kkarnati1980/devos"),       // own PR: reviewed
    pr("kkarnati1980", "kkarnati1980/devos-fork"),  // own fork: not
    pr("mallory", "mallory/devos"),                 // stranger's fork
    pr("mallory", "kkarnati1980/devos"),            // stranger with push access: not on the list
    pr("kkarnati1980", null),                       // deleted head repo
    pr(null, "kkarnati1980/devos"),                 // no author
    pr("kkarnati19800", "kkarnati1980/devos"),      // prefix/suffix of an allowed login
    pr("kkarnati", "kkarnati1980/devos"),
  ]);
  assert.deepEqual(got, ["yes", "no", "no", "no", "no", "no", "no", "no"]);
});

test("AT18: REVIEW_AUTHORS extends the allow-list; a login with spaces or symbols never matches", () => {
  const got = trust("kkarnati1980 helper-bot", [pr("helper-bot", "kkarnati1980/devos"), pr("kkarnati1980 helper-bot", "kkarnati1980/devos"), pr("helper", "kkarnati1980/devos")]);
  assert.deepEqual(got, ["yes", "no", "no"]);
});

test("AT18: the main loop checks trust before draft, publication, stored-verdict and review steps", () => {
  const src = execFileSync("sed", ["-n", '/^for i in /,/^done/p', "scripts/review/review-watch.sh"], { cwd: ROOT, encoding: "utf8" });
  const at = (s) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  const t = at("trusted_pr");
  for (const later of ['"$draft" == "true"', "published \"$sha\"", '"$STATE/$sha.msg"', '"$VDIR/$sha.json"', "$RUNNER"]) assert.ok(t < at(later), later);
  assert.match(src, /external PR, not reviewed/);
});
