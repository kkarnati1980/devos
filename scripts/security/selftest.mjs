#!/usr/bin/env node
// S2 self-test (docs/modules/S2.md AT5, AT6): the gates fail on seeded fixtures and pass on their clean twins.
// Fixtures live in a temp dir and are built at run time; no fake secret is ever committed to devos.
import { spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const rand = (alphabet, n) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");

function gitRepo(dir, files) {
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git("add", ".");
  git("-c", "user.name=s2-selftest", "-c", "user.email=s2-selftest@example.invalid", "commit", "-q", "-m", "fixture");
}

function runGate(script, arg) {
  const r = spawnSync(process.execPath, [here(script), arg], { encoding: "utf8", timeout: 6 * 60 * 1000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function packageLock(name, version) {
  return JSON.stringify(
    {
      name: "s2-fixture",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "s2-fixture", version: "0.0.0", dependencies: { [name]: version } },
        [`node_modules/${name}`]: { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz` },
      },
    },
    null,
    2,
  );
}

const results = [];
function check(id, label, cond, out) {
  results.push({ id, label, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"} ${id} ${label}`);
  if (!cond) console.log(out.split("\n").map((l) => `    ${l}`).join("\n"));
}

const root = mkdtempSync(join(tmpdir(), "s2-selftest-"));
try {
  // AT5 — seeded fake secrets (random, built here, never committed to devos).
  const seeded = join(root, "seeded");
  const clean = join(root, "clean");
  for (const d of [seeded, clean]) mkdirSync(d, { recursive: true });
  const fakeGithub = `ghp_${rand(ALNUM, 36)}`;
  const fakeAws = `AKIA${rand(UPPER, 16)}`;
  gitRepo(seeded, { "config.js": `export const token = "${fakeGithub}";\nexport const awsKey = "${fakeAws}";\n` });
  gitRepo(clean, { "config.js": 'export const greeting = "hello";\n' });
  const s1 = runGate("./secret-scan.mjs", seeded);
  check("AT5a", "seeded fake secret: secret-scan exits 1", s1.status === 1, s1.out);
  check("AT5b", "seeded fake secret: both rules reported", /github-pat/.test(s1.out) && /aws-access-token/.test(s1.out), s1.out);
  check("AT5c", "seeded fake secret: no secret value printed", !s1.out.includes(fakeGithub) && !s1.out.includes(fakeAws), "(secret value found in output)");
  const s2 = runGate("./secret-scan.mjs", clean);
  check("AT5d", "clean twin: secret-scan exits 0", s2.status === 0, s2.out);

  // AT5e–AT5h (DEVOS-197) — `pnpm secret-scan:local` with the real gitleaks: only <base>..HEAD is scanned.
  const local = join(root, "local");
  mkdirSync(local, { recursive: true });
  const lgit = (...a) => execFileSync("git", a, { cwd: local, stdio: "pipe" });
  const lcommit = (name, body) => {
    writeFileSync(join(local, name), body);
    lgit("add", ".");
    lgit("-c", "user.name=s2-selftest", "-c", "user.email=s2-selftest@example.invalid", "commit", "-q", "-m", name);
  };
  const runLocal = (base) => {
    const r = spawnSync(process.execPath, [here("./secret-scan-local.mjs"), "--base", base, "--repo", local], { encoding: "utf8", timeout: 6 * 60 * 1000 });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  lgit("init", "-q", "-b", "main");
  lcommit("readme.txt", "fixture repo\n");
  lgit("branch", "base");
  const fakeLocal = `ghp_${rand(ALNUM, 36)}`;
  lcommit("config.js", `export const token = "${fakeLocal}";\n`);
  const l1 = runLocal("base");
  check("AT5e", "key-like value in an unpushed commit: secret-scan:local exits 1", l1.status === 1 && /github-pat/.test(l1.out), l1.out);
  check("AT5f", "secret-scan:local prints no secret value", !l1.out.includes(fakeLocal), "(secret value found in output)");
  lgit("branch", "-f", "base", "HEAD");
  lcommit("clean.txt", "obviously fake: test-key-not-real\n");
  const l2 = runLocal("base");
  check("AT5g", "clean unpushed commit: secret-scan:local exits 0 (commits already on the base are not rescanned)", l2.status === 0, l2.out);
  const l3 = runLocal("no-such-base");
  check("AT5h", "unknown base: secret-scan:local exits 2, never 0", l3.status === 2, l3.out);

  // AT6 — pinned vulnerable test package (lodash 4.17.20, CVE-2021-23337, CVSS 7.2).
  const vulnDir = join(root, "vuln");
  const okDir = join(root, "ok");
  for (const d of [vulnDir, okDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(vulnDir, "package-lock.json"), packageLock("lodash", "4.17.20"));
  writeFileSync(join(okDir, "package-lock.json"), packageLock("ms", "2.1.3"));
  const v1 = runGate("./vuln-scan.mjs", join(vulnDir, "package-lock.json"));
  check("AT6a", "pinned vulnerable package: vuln-scan exits 1", v1.status === 1, v1.out);
  check("AT6b", "pinned vulnerable package: CVE-2021-23337 blocks", /BLOCK lodash@4\.17\.20 .*(CVE-2021-23337|GHSA-35jh-r3h4-6jhm)/.test(v1.out), v1.out);
  const v2 = runGate("./vuln-scan.mjs", join(okDir, "package-lock.json"));
  check("AT6c", "clean twin: vuln-scan exits 0", v2.status === 0, v2.out);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `selftest: FAIL (${failed.length}/${results.length})` : `selftest: PASS (${results.length}/${results.length})`);
process.exit(failed.length ? 1 : 0);
