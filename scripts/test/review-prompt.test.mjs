// DEVOS-249: review-commit.sh tells Codex that a KK-only floor-guard hit gets no Codex KEEP and is not a
// finding only because KK's SHA-bound Linear answer is absent (docs/modules/M0.3.md, "KK-only hits in the prompt", AT11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/review/review-commit.sh");

test("AT11 (DEVOS-249): a KK-only hit gets no Codex Keep and is not a finding for KK's missing answer", () => {
  const out = execFileSync("bash", ["-c", 'source "$1"; floor_guard_rules', "x", SCRIPT], { encoding: "utf8" });
  const flat = out.replace(/\s+/g, " ");
  // The existing marker rules are kept, word for word in meaning.
  assert.match(flat, /you may write FLOOR-GUARD KEEP <id> <file>:<line> <reason>/);
  assert.match(flat, /write FLOOR-GUARD CHANGE <path> once per changed path/);
  for (const g of ["scripts/floor-guard/\\*\\*", "scripts/test/floor-guard\\.test\\.mjs", "\\.github/workflows/floor-guard\\.yml", "scripts/gates/kk-only\\.mjs", "scripts/test/kk-only\\.test\\.mjs"]) assert.match(flat, new RegExp(g));
  assert.match(flat, /An unjustified hit is a finding, not a Keep\./);
  // KK-only areas: no Keep, KK's SHA-bound answer is the merge gate's to check, the change itself is still judged.
  assert.match(flat, /A hit in money, data deletion, security scanning, legal, D11 or D13 is KK's to dispose of, never yours: write no FLOOR-GUARD KEEP for it\./);
  assert.match(flat, /the merge gate refuses the merge without that answer \(GI-1e\)/);
  assert.match(flat, /KK's answer being absent from what you were given is not a finding\./);
  assert.match(flat, /if it weakens a scan, a check or a control, or does more than its contract records, that is a finding\./);
  // The prompt uses this text (read from the script, as the main body needs root and Codex).
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.match(src, /^fgrules="\$\(floor_guard_rules\)"$/m);
  assert.match(src, /^\$\{fgrules\}\n\$\{fgblock\}$/m);
  assert.equal(src.replace(/\s+/g, " ").split("An unjustified hit is a finding").length - 1, 1); // one copy only, anywhere in the script
});
