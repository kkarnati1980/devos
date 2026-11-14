// DEVOS-197: `pnpm secret-scan:local` (scripts/security/secret-scan-local.mjs) and the pinned installer.
// gitleaks itself is stubbed here (the build job has no gitleaks); the real-gitleaks checks are AT5e–AT5h in
// scripts/security/selftest.mjs, which the security-selftest job runs with the pinned binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, resolveGitleaks } from "../security/secret-scan-local.mjs";
import { cachedGitleaksPath, install, pinnedGitleaks } from "../security/install-gitleaks.mjs";

const SCRIPT = fileURLToPath(new URL("../security/secret-scan-local.mjs", import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "s2-local-test-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  const commit = (name, body) => {
    writeFileSync(join(dir, name), body);
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", name);
  };
  commit("a.txt", "hello\n");
  git("branch", "base");
  return { dir, git, commit };
}

// A gitleaks stand-in: records its argv and writes the report named by STUB_FINDINGS, exiting STUB_STATUS.
function stub(dir) {
  const p = join(dir, "gitleaks-stub.mjs");
  writeFileSync(p, `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "version") { console.log(process.env.STUB_VERSION ?? "${pinnedGitleaks().version}"); process.exit(0); }
writeFileSync(process.env.STUB_ARGS, JSON.stringify(args));
if (process.env.GITLEAKS_CONFIG) process.exit(9);
const i = args.indexOf("--report-path");
if (process.env.STUB_FINDINGS !== "none") writeFileSync(args[i + 1], process.env.STUB_FINDINGS ?? "[]");
process.exit(Number(process.env.STUB_STATUS ?? 0));
`);
  chmodSync(p, 0o755);
  return p;
}

function run(cwd, argv, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("DEVOS-197: scans only <base>..HEAD with the CI flags; exit 1 on a finding, 0 when clean", () => {
  const { dir, commit } = repo();
  try {
    commit("b.txt", "new work\n");
    const bin = stub(dir);
    const argsFile = join(dir, "args.json");
    const finding = JSON.stringify([{ RuleID: "generic-api-key", File: "b.txt", StartLine: 1, Commit: "abcdef1234567890", Secret: "REDACTED-VALUE-X", Match: "REDACTED-VALUE-X" }]);
    const bad = run(dir, ["--base", "base"], { GITLEAKS: bin, STUB_ARGS: argsFile, STUB_STATUS: "1", STUB_FINDINGS: finding });
    assert.equal(bad.status, 1, bad.out);
    assert.match(bad.out, /LEAK rule=generic-api-key file=b\.txt:1 commit=abcdef123456/);
    assert.match(bad.out, /FAIL \(1 finding\(s\): generic-api-key\)/);
    assert.ok(!bad.out.includes("REDACTED-VALUE-X"), "the secret and match fields are never printed");
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    // CI's flags (scripts/security/secret-scan.mjs), then the range, then the repo last.
    const i = args.indexOf("--report-path");
    assert.deepEqual(args.slice(0, i), ["git", "--no-banner", "--redact", "--exit-code", "1", "--report-format", "json"]);
    assert.deepEqual(args.slice(i + 2), ["--log-opts=base..HEAD", "."], "only the commits about to be pushed, then the repo");
    // A GITLEAKS_CONFIG in the caller's shell never reaches gitleaks (the stub exits 9 if it does).
    const ok = run(dir, ["--base", "base"], { GITLEAKS: bin, STUB_ARGS: argsFile, STUB_STATUS: "0", STUB_FINDINGS: "[]", GITLEAKS_CONFIG: join(dir, "weaker.toml") });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /PASS \(1 commit\(s\) in base\.\.HEAD, no secrets\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEVOS-197: tool and setup failures exit 2, never 0", () => {
  const { dir, commit } = repo();
  try {
    commit("b.txt", "new work\n");
    const bin = stub(dir);
    const env = { GITLEAKS: bin, STUB_ARGS: join(dir, "args.json") };
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "3" }).status, 2, "gitleaks error status");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "1", STUB_FINDINGS: "[]" }).status, 2, "exit 1 with an empty report");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: '[{"RuleID":"x","File":"f","StartLine":1}]' }).status, 2, "exit 0 with findings");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: "not json" }).status, 2, "report not JSON");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: "" }).status, 2, "empty report with commits to scan (Codex PR120-r1)");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: "[" }).status, 2, "truncated report");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: "{}" }).status, 2, "report that is not a list");
    assert.equal(run(dir, ["--base", "base"], { ...env, STUB_STATUS: "0", STUB_FINDINGS: "none" }).status, 2, "report missing with commits to scan");
    const old = run(dir, ["--base", "base"], { ...env, STUB_VERSION: "8.18.0" });
    assert.equal(old.status, 2, "a gitleaks that is not the CI-pinned version");
    assert.match(old.out, /not the CI-pinned/);
    const missing = run(dir, ["--base", "base"], { GITLEAKS: join(dir, "no-such-gitleaks") });
    assert.equal(missing.status, 2);
    assert.match(missing.out, /install-gitleaks\.mjs/);
    const noBase = run(dir, ["--base", "no-such-branch"], env);
    assert.equal(noBase.status, 2);
    assert.match(noBase.out, /not found/);
    assert.equal(run(dir, ["--base", "--all"], env).status, 2, "a base that git would read as an option");
    assert.equal(run(dir, ["--bogus"], env).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEVOS-197: no new commits passes without needing a report", () => {
  const { dir } = repo();
  try {
    const bin = stub(dir);
    const r = run(dir, ["--base", "base"], { GITLEAKS: bin, STUB_ARGS: join(dir, "args.json"), STUB_STATUS: "0", STUB_FINDINGS: "none" });
    assert.equal(r.status, 0, r.out);
    const empty = run(dir, ["--base", "base"], { GITLEAKS: bin, STUB_ARGS: join(dir, "args.json"), STUB_STATUS: "0", STUB_FINDINGS: "" });
    assert.equal(empty.status, 0, "an empty report is accepted only when there was nothing to scan");
    assert.match(r.out, /PASS \(0 commit\(s\) in base\.\.HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEVOS-197: argument parsing defaults to origin/main and refuses option-like refs", () => {
  assert.deepEqual(parseArgs([]), { base: "origin/main", repo: "." });
  assert.deepEqual(parseArgs(["--base", "main~3"]), { base: "main~3", repo: "." });
  assert.throws(() => parseArgs(["--base", "-p"]), /git ref/);
  assert.throws(() => parseArgs(["--base", "a b"]), /git ref/);
  assert.throws(() => parseArgs(["--base"]), /git ref/);
  assert.deepEqual(parseArgs(["--repo", "/tmp/x"]), { base: "origin/main", repo: "/tmp/x" });
  assert.throws(() => parseArgs(["--repo", "--config=weak.toml"]), /must be a path/);
});

test("DEVOS-197: the local gitleaks pin is the CI pin, and a checksum mismatch installs nothing", async () => {
  const action = readFileSync(fileURLToPath(new URL("../../.github/actions/security-tools/action.yml", import.meta.url)), "utf8");
  const pin = pinnedGitleaks();
  assert.ok(action.includes(`GITLEAKS_VERSION: "${pin.version}"`) && action.includes(`GITLEAKS_SHA256: "${pin.sha256}"`));
  assert.throws(() => pinnedGitleaks("nothing here"), /not found/);
  const home = mkdtempSync(join(tmpdir(), "s2-cache-"));
  try {
    const env = { XDG_CACHE_HOME: home };
    assert.equal(cachedGitleaksPath(pin.version, env), join(home, "devos-tools", `gitleaks-${pin.version}`, "gitleaks"));
    assert.equal(resolveGitleaks({ ...env, GITLEAKS: "/x/gitleaks" }), "/x/gitleaks");
    assert.equal(resolveGitleaks(env), "gitleaks", "nothing cached: PATH");
    // CI and the runners are linux x64, the only platform the installer supports.
    const fetchImpl = async () => new Response("not the gitleaks tarball", { status: 200 });
    await assert.rejects(install({ env, fetchImpl }), /checksum mismatch/);
    assert.ok(!existsSync(cachedGitleaksPath(pin.version, env)), "nothing installed");
    await assert.rejects(install({ env, fetchImpl: async () => new Response("", { status: 404 }) }), /HTTP 404/);
    assert.ok(!existsSync(cachedGitleaksPath(pin.version, env)), "nothing installed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
