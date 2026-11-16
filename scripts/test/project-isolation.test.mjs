// S4-c1 (DEVOS-128, docs/modules/S4.md "S4-c probe decisions"): scripts/server/checks/project-isolation.sh against a
// fake `docker` (and `ip`). AT11 on every devos-p container; AT10 from a probe container on the probe's networks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CHECK = path.join(ROOT, "scripts/server/checks/project-isolation.sh");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-iso-probe-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The fake docker reads a scenario (JSON) and logs every call. `run` gets the probe program on stdin and answers
// each target from scenario.outcomes (default "timeout") and the egress line from scenario.egress.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("fs");
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(a) + "\n");
const out = (s) => { process.stdout.write(s + "\n"); process.exit(0); };
const fmt = a[a.indexOf("--format") + 1] || "";
const last = a[a.length - 1];
if (a[0] === "network" && a[1] === "ls") out(Object.keys(sc.networks).join("\n"));
if (a[0] === "network" && a[1] === "inspect") {
  const n = sc.networks[last]; if (!n) process.exit(1);
  if (fmt.includes("bridge.name")) out(n.bridge || "");
  if (fmt.includes("$id")) out(Object.keys(n.containers || {}).join(" "));
  if (fmt.includes("Gateway")) out(n.gateway || "");
  if (fmt.includes("IPv4Address")) out(Object.values(n.containers || {}).map((c) => c.ip + "/24").join(" "));
}
if (a[0] === "inspect") { const c = Object.values(sc.networks).flatMap((n) => Object.entries(n.containers || {})).find(([id]) => id === last); if (!c) process.exit(1); out(c[1].limits); }
if (a[0] === "ps") out(sc.image || "");
if (a[0] === "run") {
  if (sc.runFails) process.exit(125);
  const prog = fs.readFileSync(0, "utf8");
  if (!prog.includes("net.connect")) process.exit(2);
  const i = a.indexOf("-"); const url = a[i + 1]; const targets = a.slice(i + 2);
  const net = a[a.indexOf("--network") + 1];
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ run: { net, url, targets } }) + "\n");
  const lines = targets.map((t) => t + " " + ((sc.outcomes || {})[net + " " + t] || "timeout"));
  lines.push("egress " + ((sc.egress || {})[net] || "blocked"));
  out(lines.join("\n"));
}
process.exit(1);
`;

const OK_LIMITS = '250000000 134217728 64 ["no-new-privileges:true"]';
const base = () => ({
  image: "ghcr.io/kkarnati1980/devos-api:abc123",
  networks: {
    bridge: { bridge: "docker0", containers: { aaaaaaaaaaaa: { ip: "172.17.0.2", limits: "0 0 0 null" } } },
    "devos-p-shop-live": { bridge: "devos-p3", gateway: "10.208.3.1", containers: { bbbbbbbbbbbb: { ip: "10.208.3.2", limits: OK_LIMITS } } },
    "devos-p-devos-probe-s4-preview": { bridge: "devos-p7", gateway: "10.208.7.1", containers: { cccccccccccc: { ip: "10.208.7.2", limits: OK_LIMITS } } },
    "devos-p-devos-probe-s4-live": { bridge: "devos-p8", gateway: "10.208.8.1", containers: { dddddddddddd: { ip: "10.208.8.2", limits: OK_LIMITS } } },
  },
});

function run(name, scenario, { rules = "", noDocker = false } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "devos/isolation"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "devos/isolation/installed.rules"), rules);
  fs.writeFileSync(path.join(dir, "scenario.json"), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, "log"), "");
  if (!noDocker) fs.writeFileSync(path.join(bin, "docker"), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ip"), "#!/usr/bin/env bash\necho '5: tailscale0    inet 100.101.102.103/32 scope global tailscale0'\n", { mode: 0o755 });
  for (const t of ["timeout", "bash", "node", "sed", "head", "tr", "grep"]) {
    const real = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(real, path.join(bin, t));
  }
  const r = spawnSync("/bin/bash", [CHECK], { encoding: "utf8", timeout: 60_000, env: { PATH: bin, DEVOS_DIR: path.join(dir, "devos"), FAKE_SCENARIO: path.join(dir, "scenario.json"), FAKE_LOG: path.join(dir, "log") } });
  const calls = fs.readFileSync(path.join(dir, "log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: r.status, out: (r.stdout + r.stderr).trim(), calls };
}

test("pass: AT11 on every devos-p container (not docker0); AT10 from each probe network with the floor and every target", () => {
  const r = run("pass", base());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^note: AT10's declared-egress half is not yet testable/m);
  assert.match(r.out, /^ok: AT11 passed on 3 container\(s\); AT10 passed on 2 probe network\(s\)$/m);
  const inspected = r.calls.filter((c) => Array.isArray(c) && c[0] === "inspect").map((c) => c.at(-1)).sort();
  assert.deepEqual(inspected, ["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"], "docker0's container is not a project container");
  for (const c of r.calls.filter((c) => Array.isArray(c) && c[0] === "inspect")) assert.ok(c.includes("--format"), "never a bare inspect");
  const runs = r.calls.filter((c) => Array.isArray(c) && c[0] === "run");
  assert.equal(runs.length, 2);
  for (const flag of ["--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--user", "65534:65534", "--cpus", "--memory", "--pids-limit"]) assert.ok(runs[0].includes(flag), flag);
  assert.ok(!runs.some((c) => c.includes("devos-p-shop-live")), "a real project's network is never joined");
  const probe = r.calls.filter((c) => c.run).map((c) => c.run);
  const pv = probe.find((p) => p.net === "devos-p-devos-probe-s4-preview");
  assert.deepEqual(pv.targets, ["10.208.7.1:22", "10.208.7.1:8000", "10.208.7.1:6001", "10.208.7.1:6002", "10.208.7.1:3001", "10.208.7.1:3000", "169.254.169.254:80", "100.101.102.103:443", "10.208.8.2:5432"]);
  assert.equal(pv.url, "https://api.github.com/zen");
});

test("fail: a refused or open target, undeclared egress that succeeds, declared egress that is blocked", () => {
  const sc = base();
  sc.outcomes = { "devos-p-devos-probe-s4-preview 10.208.7.1:22": "refused", "devos-p-devos-probe-s4-live 169.254.169.254:80": "open", "devos-p-devos-probe-s4-live 10.208.7.2:5432": "unreachable" };
  sc.egress = { "devos-p-devos-probe-s4-preview": "status-200" };
  const r = run("fail", sc, { rules: '-A DEVOS-ISO-FWD -s 10.208.8.0/24 -m comment --comment "devos-probe-s4/live egress" -j RETURN\n' });
  assert.equal(r.code, 1);
  const lines = r.out.split("\n").sort();
  assert.ok(lines.includes("AT10 devos-p-devos-probe-s4-preview: 10.208.7.1:22 refused"), r.out);
  assert.ok(lines.includes("AT10 devos-p-devos-probe-s4-live: 169.254.169.254:80 open"), r.out);
  assert.ok(lines.includes("AT10 devos-p-devos-probe-s4-preview: undeclared egress gave status-200"), r.out);
  assert.ok(lines.includes("AT10 devos-p-devos-probe-s4-live: declared egress gave blocked"), r.out);
  assert.ok(!r.out.includes("5432 unreachable"), "unreachable counts as blocked");
  assert.match(r.out, /^fail: 4 problem\(s\)/m);
});

test("fail AT11: a project container without limits or no-new-privileges; skipped AT10 without a probe network", () => {
  const sc = base();
  sc.networks["devos-p-shop-live"].containers.bbbbbbbbbbbb.limits = '0 134217728 64 ["no-new-privileges:true"]';
  sc.networks["devos-p-shop-live"].containers.eeeeeeeeeeee = { ip: "10.208.3.3", limits: OK_LIMITS.replace("no-new-privileges:true", "seccomp=unconfined") };
  const r = run("at11", sc);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("AT11 bbbbbbbbbbbb on devos-p-shop-live: missing cpu/memory/pids limit"), r.out);
  assert.ok(r.out.includes("AT11 eeeeeeeeeeee on devos-p-shop-live: no no-new-privileges"), r.out);

  const noProbe = base();
  delete noProbe.networks["devos-p-devos-probe-s4-preview"];
  delete noProbe.networks["devos-p-devos-probe-s4-live"];
  const s = run("noprobe", noProbe);
  assert.deepEqual([s.code, s.out], [3, "skipped: AT11 passed on 1 container(s); no devos-probe-s4 network, so AT10 did not run"]);
  assert.ok(!s.calls.some((c) => Array.isArray(c) && c[0] === "run"));
});

test("fail: no API image to probe with, or the probe container does not run; skipped without docker", () => {
  const sc = base();
  sc.image = "";
  const r = run("noimg", sc);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes("AT10: no running DevOS API image to probe with"), r.out);
  const sc2 = base();
  sc2.runFails = true;
  const r2 = run("runfail", sc2);
  assert.equal(r2.code, 1);
  assert.ok(r2.out.includes("AT10 devos-p-devos-probe-s4-preview: the probe container did not run"), r2.out);
  const r3 = run("nodocker", base(), { noDocker: true });
  assert.deepEqual([r3.code, r3.out], [3, "skipped: docker not installed"]);
});

test("a network whose bridge is not devos-p<idx> is not a project network, even with a devos-p name", () => {
  const sc = base();
  sc.networks["devos-p-devos-probe-s4-preview"].bridge = "br-123";
  const r = run("bridge", sc);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /AT10 passed on 1 probe network\(s\)/);
});
