// DEVOS-128 (docs/modules/S4.md "S4-c bridge-name check"): scripts/server/checks/project-bridges.sh with a fake `ip`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CHECK = path.join(ROOT, "scripts/server/checks/project-bridges.sh");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-bridges-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Runs the check with a fake `ip` printing `routes` (or exiting `ipExit`), and the installed block present or not.
function run(name, { routes = "", ipExit = 0, installed = true, noIp = false } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "devos/isolation"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  if (installed) fs.writeFileSync(path.join(dir, "devos/isolation/installed.rules"), "# block\n");
  if (!noIp) {
    fs.writeFileSync(path.join(dir, "routes"), routes);
    fs.writeFileSync(path.join(bin, "ip"), `#!/usr/bin/env bash\n[[ "$*" == "-4 -o route show" ]] || exit 9\ncat "${path.join(dir, "routes")}"\nexit ${ipExit}\n`, { mode: 0o755 });
  }
  for (const t of ["timeout", "cat", "bash"]) {
    const real = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(real, path.join(bin, t));
  }
  const r = spawnSync("/bin/bash", [CHECK], { encoding: "utf8", env: { PATH: bin, DEVOS_DIR: path.join(dir, "devos") } });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}

const HOST = [
  "default via 203.0.113.1 dev eth0 proto static",
  "10.0.1.0/24 dev docker_gwbridge proto kernel scope link src 10.0.1.1",
  "172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown",
  "100.64.0.0/10 dev tailscale0 scope link",
];

test("pass: every pool /24 is on devos-p<idx> (index across the 10.208-10.211 range); other routes are ignored", () => {
  const r = run("pass", { routes: [...HOST,
    "10.208.0.0/24 dev devos-p0 proto kernel scope link src 10.208.0.1",
    "10.208.37.0/24 dev devos-p37 proto kernel scope link src 10.208.37.1 linkdown",
    "10.209.4.0/24 dev devos-p260 proto kernel scope link src 10.209.4.1",
    "10.211.255.0/24 dev devos-p1023 proto kernel scope link src 10.211.255.1",
    "10.212.0.0/24 dev br-abc proto kernel scope link src 10.212.0.1",
    "10.20.0.0/24 dev br-def proto kernel scope link src 10.20.0.1"].join("\n") + "\n" });
  assert.deepEqual([r.code, r.out], [0, "ok: 4 project network(s), each on its devos-p<idx> bridge"]);
});

test("pass: no project network yet", () => {
  const r = run("empty", { routes: HOST.join("\n") + "\n" });
  assert.deepEqual([r.code, r.out], [0, "ok: 0 project network(s), each on its devos-p<idx> bridge"]);
});

test("fail: a pool /24 on Docker's default br-<id> name or on the wrong index", () => {
  const r = run("wrong", { routes: [...HOST,
    "10.208.5.0/24 dev br-1a2b3c4d5e6f proto kernel scope link src 10.208.5.1",
    "10.208.6.0/24 dev devos-p7 proto kernel scope link src 10.208.6.1",
    "10.208.8.0/24 dev devos-p8 proto kernel scope link src 10.208.8.1"].join("\n") + "\n" });
  assert.equal(r.code, 1);
  assert.equal(r.out, "fail: 2 pool route(s) not on their devos-p bridge: 10.208.5.0/24 on br-1a2b3c4d5e6f (expected devos-p5) 10.208.6.0/24 on devos-p7 (expected devos-p6)");
});

test("fail: a pool route that is not a stack /24 (wider prefix, host route)", () => {
  const r = run("shape", { routes: ["10.208.0.0/16 dev br-x proto kernel scope link", "10.210.3.9 dev devos-p515 scope link"].join("\n") + "\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /^fail: 2 pool route\(s\) not on their devos-p bridge: 10\.208\.0\.0\/16 on br-x \(not a stack \/24\) 10\.210\.3\.9 on devos-p515 \(not a stack \/24\)$/);
});

test("fail: an interface name with odd characters is not echoed", () => {
  const r = run("odd", { routes: "10.208.2.0/24 dev $(touch${IFS}x) scope link\n" });
  assert.equal(r.code, 1);
  assert.equal(r.out, "fail: 1 pool route(s) not on their devos-p bridge: 10.208.2.0/24 on ? (expected devos-p2)");
});

test("fail: the routes cannot be read; skipped without the installed block or without ip", () => {
  assert.deepEqual(Object.values(run("iperr", { ipExit: 2 })), [1, "fail: cannot read the IPv4 routes"]);
  assert.deepEqual(Object.values(run("noblock", { installed: false })), [3, "skipped: the isolation block is not installed yet"]);
  assert.deepEqual(Object.values(run("noip", { noIp: true })), [3, "skipped: no ip command"]);
});
