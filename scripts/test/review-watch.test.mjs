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
