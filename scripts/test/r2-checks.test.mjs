// R2 AT5 (docs/modules/R2.md): the G1 server checks caps-saved, receipt-chain and run-resume against a fake
// `docker` on PATH. Each returns 3 without its precondition, 1 on a seeded failure and 0 on success.
// The live run (real stack, real SIGKILL) is the `release-images` compose-smoke step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const CHECKS = join(root, "scripts/server/checks");
const ID = "abcdef012345";
const RUN = "22222222-2222-4222-8222-222222222222";

// Fake docker: `ps` prints FAKE_PS; `exec … g1-cli.js <cmd>` answers from FAKE_<CMD>_OUT/RC, and for
// probe-status from FAKE_STATUS_BEFORE / FAKE_STATUS_AFTER depending on whether `kill` was called.
const FAKE = `#!/usr/bin/env bash
log="$FAKE_DIR/docker.log"; echo "$*" >> "$log"
case "$1" in
  ps) [[ -n "\${FAKE_PS:-}" ]] && echo "$FAKE_PS"; exit 0 ;;
  kill) touch "$FAKE_DIR/killed"; exit "\${FAKE_KILL_RC:-0}" ;;
  start) exit "\${FAKE_START_RC:-0}" ;;
  exec)
    cmd=""; for a in "$@"; do [[ "$prev" == *g1-cli.js ]] && cmd="$a"; prev="$a"; done
    case "$cmd" in
      caps) echo "$FAKE_CAPS_OUT"; exit "\${FAKE_CAPS_RC:-0}" ;;
      receipts) echo "$FAKE_RECEIPTS_OUT"; exit "\${FAKE_RECEIPTS_RC:-0}" ;;
      probe-start) echo "$FAKE_START_OUT"; exit "\${FAKE_START_HELPER_RC:-0}" ;;
      probe-status)
        if [[ -e "$FAKE_DIR/killed" ]]; then echo "$FAKE_STATUS_AFTER"; exit "\${FAKE_STATUS_AFTER_RC:-0}"
        else echo "$FAKE_STATUS_BEFORE"; exit "\${FAKE_STATUS_BEFORE_RC:-3}"; fi ;;
    esac ;;
esac
exit 0
`;

function bin({ docker = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "r2-"));
  for (const tool of ["bash", "sed", "grep", "head", "timeout", "sleep", "tr", "env", "touch", "cat"]) {
    for (const d of ["/usr/bin", "/bin"]) if (existsSync(join(d, tool))) { try { symlinkSync(join(d, tool), join(dir, tool)); } catch {} break; }
  }
  if (docker) { writeFileSync(join(dir, "docker"), FAKE); chmodSync(join(dir, "docker"), 0o755); }
  return dir;
}

function run(check, env = {}, opts = {}) {
  const dir = bin(opts);
  const r = spawnSync(join(dir, "bash"), [join(CHECKS, check)], {
    env: { PATH: dir, FAKE_DIR: dir, FAKE_PS: ID, G1_POLL_SECONDS: "0", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const log = existsSync(join(dir, "docker.log")) ? readFileSync(join(dir, "docker.log"), "utf8") : "";
  return { code: r.status, out: r.stdout + r.stderr, log };
}

for (const check of ["caps-saved.sh", "receipt-chain.sh", "run-resume.sh"]) {
  test(`AT5 ${check}: skipped (3) without docker or without a running DevOS worker`, () => {
    assert.equal(run(check, {}, { docker: false }).code, 3);
    const none = run(check, { FAKE_PS: "" });
    assert.equal(none.code, 3);
    assert.match(none.out, /no running DevOS worker/);
    assert.match(none.log, /label=io\.devos\.service=worker/);
  });
}

for (const [check, key] of [["caps-saved.sh", "CAPS"], ["receipt-chain.sh", "RECEIPTS"]]) {
  test(`AT5 ${check}: the helper's pass, skip and fail reach the server agent unchanged; anything else is a fail`, () => {
    const pass = run(check, { [`FAKE_${key}_OUT`]: '{"result":"pass"}', [`FAKE_${key}_RC`]: "0" });
    assert.equal(pass.code, 0);
    assert.match(pass.out, /"result":"pass"/);
    assert.match(pass.log, /exec abcdef012345 node deploy\/with-db-url\.mjs node packages\/run-engine\/dist\/g1-cli\.js/);
    assert.equal(run(check, { [`FAKE_${key}_OUT`]: '{"result":"skipped"}', [`FAKE_${key}_RC`]: "3" }).code, 3);
    assert.equal(run(check, { [`FAKE_${key}_OUT`]: '{"result":"fail","reason":"seeded"}', [`FAKE_${key}_RC`]: "1" }).code, 1);
    assert.equal(run(check, { [`FAKE_${key}_OUT`]: "", [`FAKE_${key}_RC`]: "2" }).code, 1);
    assert.equal(run(check, { [`FAKE_${key}_OUT`]: "", [`FAKE_${key}_RC`]: "125" }).code, 1);
  });
}

const START = `{"result":"pass","runId":"${RUN}","projectId":"p"}`;
const RUNNING = `{"result":"running","runId":"${RUN}","status":"running","turns":1}`;

test("AT5 run-resume: starts a probe, SIGKILLs the worker after a checkpointed turn, restarts it, passes on a resumed run", () => {
  const r = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: RUNNING, FAKE_STATUS_AFTER: `{"result":"pass","runId":"${RUN}","status":"succeeded","turns":4,"resumed":true}` });
  assert.equal(r.code, 0, r.out);
  const lines = r.log.trim().split("\n");
  const kill = lines.findIndex((l) => l === `kill --signal KILL ${ID}`);
  const start = lines.findIndex((l) => l === `start ${ID}`);
  assert.ok(kill > 0 && start > kill, `kill then start, got:\n${r.log}`);
  assert.match(lines[kill - 1], /probe-status 2222/, "the kill follows a status read that showed a turn");
});

test("AT5 run-resume: another active run means skipped (3) and the worker is never killed", () => {
  const r = run("run-resume.sh", { FAKE_START_OUT: '{"result":"skipped","reason":"worker-busy"}', FAKE_START_HELPER_RC: "3" });
  assert.equal(r.code, 3);
  assert.doesNotMatch(r.log, /^kill/m);
});

test("AT5 run-resume: seeded failures are 1 (resume evidence fails, start fails, no turn in time, never finishes, restart fails)", () => {
  const failAfter = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: RUNNING, FAKE_STATUS_AFTER: '{"result":"fail","reason":"reservation-open"}', FAKE_STATUS_AFTER_RC: "1" });
  assert.equal(failAfter.code, 1);
  assert.match(failAfter.out, /reservation-open/);
  assert.equal(run("run-resume.sh", { FAKE_START_OUT: '{"result":"fail","reason":"probe-project-paused"}', FAKE_START_HELPER_RC: "1" }).code, 1);
  const noTurn = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: `{"status":"running","turns":0}`, G1_KILL_BY_SECONDS: "1" });
  assert.equal(noTurn.code, 1);
  assert.doesNotMatch(noTurn.log, /^kill/m, "no kill without a checkpointed turn");
  const endedEarly = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: `{"status":"failed","turns":0}`, FAKE_STATUS_BEFORE_RC: "1" });
  assert.equal(endedEarly.code, 1);
  const never = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: RUNNING, FAKE_STATUS_AFTER: RUNNING, FAKE_STATUS_AFTER_RC: "3", G1_FINISH_BY_SECONDS: "2", G1_POLL_SECONDS: "1" });
  assert.equal(never.code, 1);
  assert.match(never.out, /did not finish/);
  const noRestart = run("run-resume.sh", { FAKE_START_OUT: START, FAKE_STATUS_BEFORE: RUNNING, FAKE_START_RC: "1" });
  assert.equal(noRestart.code, 1);
  assert.match(noRestart.out, /docker start failed/);
});
