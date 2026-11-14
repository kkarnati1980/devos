// DEVOS-202 (CI-T-b AT13, notes 0017 and 0023): ci-gate.yml runs the BASE commit's copy of the gate's code, so a
// head can never change the rules its own ci-gate result is judged by. The workflow's own staging and gate steps
// are run here, as written, against a fixture checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const WF = parse(readFileSync(".github/workflows/ci-gate.yml", "utf8"));
const STEPS = WF.jobs["ci-gate"].steps;
const STAGE = STEPS.find((s) => /^Use the base commit's copy of the gate's code/.test(s.name ?? ""));
const GATE = STEPS.find((s) => s.name === "Wait for every PR check on the head SHA");
const GATE_FILES = ["scripts/ci/ci-gate.mjs", "scripts/release/merge.mjs", "scripts/release/required-checks.json", "scripts/floor-guard/floor-guard.mjs", "scripts/gates/kk-only.mjs"];

const put = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const yamlPkg = (root, marker) => {
  put(root, "node_modules/yaml/package.json", JSON.stringify({ name: "yaml", type: "module", main: "index.js" }));
  put(root, "node_modules/yaml/index.js", `export const marker = ${JSON.stringify(marker)};\n`);
};

/** A head checkout with a full base checkout at .gate-src (what the checkout steps leave behind). */
function fixture({ omit = null, pnpmMakesYaml = true, tamper = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-gate-wf-"));
  const ws = join(root, "ws"), rt = join(root, "runner-temp"), bin = join(root, "bin");
  mkdirSync(rt, { recursive: true });
  // Head: the gate and its rules edited to always pass, plus a head extra file and a head yaml, none of which
  // may be used.
  for (const f of GATE_FILES) put(ws, f, "// head\n");
  put(ws, "scripts/ci/ci-gate.mjs", 'console.log("head gate: always pass"); process.exit(0);\n');
  put(ws, "scripts/release/merge.mjs", 'export const marker = "head-merge";\n');
  put(ws, "scripts/release/extra.mjs", "// head only\n");
  yamlPkg(ws, "head-yaml");
  // Base: the real rules (here: a failure) that must judge the head.
  const base = join(ws, ".gate-src");
  for (const f of GATE_FILES) put(base, f, "// base\n");
  put(base, "scripts/release/merge.mjs", 'export const marker = "base-merge";\n');
  put(base, "scripts/ci/ci-gate.mjs", 'const y = await import("yaml");\nconst m = await import("../release/merge.mjs");\nconsole.log(`base gate: judged with ${y.marker} and ${m.marker}; cwd ${process.cwd()}`);\nprocess.exit(1);\n');
  if (omit) rmSync(join(base, omit), { recursive: true });
  if (tamper) tamper(ws, root);
  // pnpm stub: records where it ran, and installs a yaml into that directory unless told not to.
  put(bin, "pnpm", `#!/usr/bin/env bash\necho "$PWD $*" >> "${join(root, "pnpm.log")}"\n${pnpmMakesYaml ? `mkdir -p node_modules/yaml && printf '{"name":"yaml","type":"module","main":"index.js"}' > node_modules/yaml/package.json && echo 'export const marker = "base-yaml";' > node_modules/yaml/index.js` : "true"}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: rt, BASE_SHA: "b".repeat(40), HOME: root };
  const run = (script) => spawnSync("bash", ["-e", "-c", script], { cwd: ws, env, encoding: "utf8" });
  const pnpmLog = () => (existsSync(join(root, "pnpm.log")) ? readFileSync(join(root, "pnpm.log"), "utf8") : "");
  return { root, ws, rt, run, pnpmLog };
}

test("AT13: the two original checkouts are unchanged; a third, full base checkout feeds the gate step", () => {
  const checkouts = STEPS.filter((s) => /^actions\/checkout@/.test(s.uses ?? ""));
  assert.equal(checkouts.length, 3);
  assert.equal(checkouts[0].with.ref, "${{ github.event.pull_request.head.sha }}");
  assert.deepEqual(checkouts[1].with, { ref: "${{ github.event.pull_request.base.sha }}", path: ".gate-base", "sparse-checkout": ".github/workflows", "persist-credentials": false });
  assert.deepEqual(checkouts[2].with, { ref: "${{ github.event.pull_request.base.sha }}", path: ".gate-src", "persist-credentials": false }, "the whole base tree");
  assert.ok(STAGE && GATE, "the base-copy and gate steps exist");
  const install = STEPS.findIndex((s) => /^Install the gate's one dependency/.test(s.name ?? ""));
  assert.ok(install >= 0 && install < STEPS.indexOf(STAGE), "the base copy replaces the head's after the head install");
  assert.ok(STEPS.indexOf(checkouts[2]) < STEPS.indexOf(STAGE) && STEPS.indexOf(STAGE) === STEPS.indexOf(GATE) - 1, "nothing runs between the swap and the gate");
  assert.equal(GATE.run.trim(), "node scripts/ci/ci-gate.mjs");
});

test("AT13: a head that edits ci-gate.mjs to always pass is still judged by the base copy (and the base yaml)", () => {
  const f = fixture();
  const st = f.run(STAGE.run);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /gate version: base b{40}/);
  assert.ok(!existsSync(join(f.ws, ".gate-src")), "the base checkout is moved out of the workspace");
  assert.ok(!existsSync(join(f.ws, "scripts/release/extra.mjs")), "head-only files in the gate's directories are gone");
  for (const p of GATE_FILES) assert.doesNotMatch(readFileSync(join(f.ws, p), "utf8"), /head/, `${p} is the base copy`);
  assert.equal(f.pnpmLog().trim(), `${join(f.rt, "gate-base")} install --frozen-lockfile --filter . --ignore-scripts --ignore-pnpmfile`);
  const g = f.run(GATE.run);
  assert.equal(g.status, 1, "the base copy's failure, not the head's pass");
  assert.match(g.stdout, /^base gate: judged with base-yaml and base-merge; cwd /);
  assert.ok(g.stdout.trim().endsWith(f.ws), "it runs in the head checkout");
  assert.doesNotMatch(g.stdout, /head gate|head-yaml|head-merge/);
});

test("AT13: a base without one of the gate files exits 2 before any install; a base install without yaml exits 2", () => {
  for (const omit of GATE_FILES) {
    const f = fixture({ omit });
    const st = f.run(STAGE.run);
    assert.equal(st.status, 2, `${omit}: ${st.stdout}${st.stderr}`);
    assert.match(st.stdout, /refusing to judge with the head's copy/);
    assert.equal(f.pnpmLog(), "", "nothing installed");
    assert.match(readFileSync(join(f.ws, "scripts/ci/ci-gate.mjs"), "utf8"), /head gate/, "and nothing swapped");
  }
  const f = fixture({ pnpmMakesYaml: false });
  const st = f.run(STAGE.run);
  assert.equal(st.status, 2, st.stdout + st.stderr);
  assert.match(st.stdout, /the base install has no yaml/);
});

test("AT13 (pre-review): head files on the gate's resolution path or run at install time are refused before any swap", () => {
  const cases = {
    "a node_modules under scripts/": (ws) => yamlPkg(join(ws, "scripts"), "head-yaml"),
    "a symlinked scripts/": (ws, root) => { renameSync(join(ws, "scripts"), join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(ws, "scripts")); },
    "a symlinked gate directory": (ws, root) => { renameSync(join(ws, "scripts/release"), join(root, "rel")); symlinkSync(join(root, "rel"), join(ws, "scripts/release")); },
    "a .pnpmfile.cjs": (ws) => put(ws, ".pnpmfile.cjs", "module.exports = {};\n"),
    "an .npmrc unlike the base's": (ws) => put(ws, ".npmrc", "registry=https://example.invalid/\n"),
  };
  for (const [why, tamper] of Object.entries(cases)) {
    const f = fixture({ tamper });
    const st = f.run(STAGE.run);
    assert.equal(st.status, 2, `${why}: ${st.stdout}${st.stderr}`);
    assert.match(st.stdout, /refusing/, why);
    assert.equal(f.pnpmLog(), "", `${why}: nothing installed`);
  }
  // The same .npmrc on both sides is fine.
  const same = fixture({ tamper: (ws) => { put(ws, ".npmrc", "x=1\n"); put(join(ws, ".gate-src"), ".npmrc", "x=1\n"); } });
  assert.equal(same.run(STAGE.run).status, 0);
});
