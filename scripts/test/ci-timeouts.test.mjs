// DEVOS-139 G3: every CI job declares `timeout-minutes`, no higher than the documented ceiling, and no step may
// outlast its job. Runs in the CI "Test" step (`pnpm test`), so a new job without a timeout fails CI.
// Ceiling and per-job values: docs/decisions/0016-ci-throughput.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const JOB_TIMEOUT_CEILING_MINUTES = 30;
const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

test("G3 there are workflows to check", () => {
  assert.ok(files.length >= 11, `found ${files.length} workflow files`);
});

for (const file of files) {
  const wf = parse(readFileSync(dir + file, "utf8"), { merge: true });
  test(`G3 ${file} parses to a workflow with jobs`, () => assert.ok(wf?.jobs, `${file} has no jobs`));
  for (const [name, job] of Object.entries(wf?.jobs ?? {})) {
    // A job that calls a reusable workflow cannot take timeout-minutes; the called file's own jobs are checked.
    if (job.uses) continue;
    test(`G3 ${file} job "${name}" declares timeout-minutes within ${JOB_TIMEOUT_CEILING_MINUTES}`, () => {
      const t = job["timeout-minutes"];
      assert.equal(typeof t, "number", `${file}:${name} timeout-minutes is ${t === undefined ? "missing" : `not a literal number (${t})`}`);
      assert.ok(t >= 1 && t <= JOB_TIMEOUT_CEILING_MINUTES, `${file}:${name} timeout ${t} is outside 1..${JOB_TIMEOUT_CEILING_MINUTES}`);
      for (const step of job.steps ?? []) {
        if (step["timeout-minutes"] === undefined) continue;
        assert.equal(typeof step["timeout-minutes"], "number", `${file}:${name} step "${step.name ?? step.uses}" timeout is not a literal number`);
        assert.ok(step["timeout-minutes"] <= t, `${file}:${name} step "${step.name ?? step.uses}" outlasts its job`);
      }
    });
  }
}
