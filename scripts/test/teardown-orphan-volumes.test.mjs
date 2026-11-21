// DEVOS-236 (docs/modules/M2.5.md "DEVOS-236 decisions"): the read-only orphan-volume server check, on a fake `docker`.
// Fakes on PATH: `docker` (ps → one API id unless FAKE_API=0; exec → prints FAKE_DIR/cli and exits FAKE_CLI_RC;
// volume ls -q → the names in FAKE_DIR/vols.json, exit FAKE_VOL_RC; volume inspect → that JSON (or FAKE_DIR/inspect
// when present), exit FAKE_INS_RC; anything else, e.g. `volume rm`, exits 99 and is recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts/server/checks/teardown-orphan-volumes.sh");

// vols: [{ Name, Labels }], as `docker volume inspect` returns them.
function run({ cli = '{"uuids":[],"invalid":0}', cliRc = 0, vols = [], volRc = 0, insRc = 0, inspect = null, api = true, psRc = 0, psOut = "" } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "devos-orphan-"));
  fs.writeFileSync(path.join(bin, "cli"), cli + "\n");
  fs.writeFileSync(path.join(bin, "vols.json"), JSON.stringify(vols));
  if (inspect !== null) fs.writeFileSync(path.join(bin, "inspect"), inspect);
  fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/docker.args"
case "$1 \${2:-}" in
  "ps "*) [[ -n "\${FAKE_PS_OUT:-}" ]] && { printf '%b' "$FAKE_PS_OUT"; exit "$FAKE_PS_RC"; }; [[ "$FAKE_API" == 1 ]] && echo abcdef123456; exit "$FAKE_PS_RC";;
  "exec "*) cat "$FAKE_DIR/cli"; exit "$FAKE_CLI_RC";;
  "volume ls") [[ "\${3:-}" == -q ]] || exit 98; jq -r '.[].Name' "$FAKE_DIR/vols.json"; exit "$FAKE_VOL_RC";;
  "volume inspect") if [[ -f "$FAKE_DIR/inspect" ]]; then cat "$FAKE_DIR/inspect"; else cat "$FAKE_DIR/vols.json"; fi; exit "$FAKE_INS_RC";;
esac
exit 99
`);
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [CHECK], {
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, FAKE_API: api ? "1" : "0", FAKE_CLI_RC: String(cliRc), FAKE_VOL_RC: String(volRc), FAKE_INS_RC: String(insRc), FAKE_PS_RC: String(psRc), FAKE_PS_OUT: psOut },
    encoding: "utf8",
  });
  const args = fs.existsSync(path.join(bin, "docker.args")) ? fs.readFileSync(path.join(bin, "docker.args"), "utf8") : "";
  fs.rmSync(bin, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr, args };
}

const U1 = "k0sgw8c4o8ss0wkc";
const U2 = "abc123-def456";

test("DEVOS-236: no purged application and no volume → pass", () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok: no leftover volume \(0 purged applications checked\)/m);
});

test("DEVOS-236: a volume named after a purged application (Coolify naming) is a leftover hit → fail", () => {
  const vols = [{ Name: `${U1}-postgres-data`, Labels: { "coolify.managed": "true" } }, { Name: `${U1}_uploads`, Labels: null }, { Name: U1, Labels: {} }, { Name: "other-volume", Labels: { x: "y" } }];
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`leftover volume: ${U1}-postgres-data \\(purged application ${U1}\\)`));
  assert.match(r.out, new RegExp(`leftover volume: ${U1}_uploads`));
  assert.match(r.out, /fail: 3 leftover volume\(s\) of purged applications \(1 purged applications checked\)/);
  assert.doesNotMatch(r.out, /other-volume/);
});

test("DEVOS-236: a volume whose label value is exactly a purged uuid is a hit; a partial or prefix match is not", () => {
  const vols = [
    { Name: "data_abc", Labels: { "com.docker.compose.project": U2, "coolify.managed": "true" } },
    { Name: "near1", Labels: { "com.docker.compose.project": `${U2}x` } },
    { Name: "near2", Labels: { note: `x${U2}` } },
    { Name: "near3", Labels: { "traefik.rule": `Host(a),${U2}` } }, // pre-review 1: a comma in a value is not a split
    { Name: "near4", Labels: { note: `line\n${U2}` } },
    { Name: `${U2}x-data`, Labels: {} },
  ];
  const r = run({ cli: JSON.stringify({ uuids: [U2], invalid: 0 }), vols });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /leftover volume: data_abc/);
  assert.doesNotMatch(r.out, /near1|near2|near3|near4|abc123-def456x-data/);
  assert.match(r.out, /fail: 1 leftover volume/);
});

test("DEVOS-236: volumes of live applications only → pass, and the check never removes anything", () => {
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: [{ Name: "liveapp0001-data", Labels: { "coolify.managed": "true" } }] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok: no leftover volume \(1 purged applications checked\)/);
  assert.doesNotMatch(r.args, /volume rm|volume prune|\brm\b/);
  assert.deepEqual(r.args.trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")), ["ps --filter", "exec abcdef123456", "volume ls", "volume inspect"]);
});

test("DEVOS-236: rows the scan cannot match make it incomplete → fail, never clean", () => {
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 2 }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail: 2 purged application row\(s\) have an id the scan cannot match/);
});

test("DEVOS-236: an unreadable or malformed list fails, never passes", () => {
  for (const cli of ["not json", '{"uuids":"x","invalid":0}', '{"uuids":[""],"invalid":0}', '{"uuids":[12345678],"invalid":0}', '{"uuids":[null],"invalid":0}', '{"uuids":["abcdefgh\\n"],"invalid":0}', '{"uuids":["\\nabcdefgh"],"invalid":0}', '{"uuids":[],"invalid":"0"}', '{"uuids":["a;b c"],"invalid":0}', '{"invalid":0}']) {
    const r = run({ cli });
    assert.equal(r.code, 1, `${cli}: ${r.out}`);
    assert.match(r.out, /fail: unreadable purged-application list/);
  }
});

test("DEVOS-236: the CLI failing or timing out fails with its fixed code; a docker volume ls error fails", () => {
  let r = run({ cli: '{"error":"teardown-volumes-read-failed"}', cliRc: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /fail: the purged-application read failed \(exit 1\): teardown-volumes-read-failed/);
  r = run({ cli: "", cliRc: 124 });
  assert.equal(r.code, 1);
  assert.match(r.out, /timed out/);
  r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), volRc: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /fail: docker volume ls failed \(exit 1\)/);
  r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: [{ Name: "v1", Labels: {} }], insRc: 1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /fail: docker volume inspect failed \(exit 1\)/);
  // Codex PR209-r1: the inspect output must describe exactly the listed volumes, each with a Labels field.
  for (const inspect of ["not json", '{"Name":"v1"}', '[{"Name":5}]', '[{"Name":"v1","Labels":"x"}]', "[]", "", "  \n", '[{"Name":"v1"}]',
                         '[{"Name":"other","Labels":{}}]', '[{"Name":"v1","Labels":{}},{"Name":"v1","Labels":{}}]', '[{"Name":"v1","Labels":{"a":5}}]']) {
    r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: [{ Name: "v1", Labels: {} }], inspect });
    assert.equal(r.code, 1, `${inspect}: ${r.out}`);
    assert.match(r.out, /fail: unreadable docker volume inspect output/);
  }
});

test("DEVOS-236: skipped only when DevOS is not deployed; no database or a failed docker ps fails", () => {
  let r = run({ api: false });
  assert.equal(r.code, 3);
  assert.match(r.out, /skipped: no running DevOS API container/);
  // Codex PR209-r1: a Docker error or a timeout is not "not deployed".
  for (const psRc of [1, 124]) {
    r = run({ api: false, psRc });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`fail: docker ps failed \\(exit ${psRc}\\)`));
  }
  // Codex PR209-r2: once the API container runs, a CLI without a database is a failure, not a skip.
  r = run({ cli: '{"code":"skipped"}', cliRc: 3 });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail: the API container has no database/);
});

test("DEVOS-236: names are printed in a fixed character set and the list stops at 15", () => {
  // Docker never allows these characters in a name; the check removes them anyway.
  const vols = Array.from({ length: 18 }, (_, i) => ({ Name: `${U1}-v${i}$(id)`, Labels: {} }));
  const inspect = JSON.stringify(vols);
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols, inspect });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /\$\(id/);
  assert.equal((r.out.match(/leftover volume:/g) || []).length, 15);
  assert.match(r.out, /\.\.\. 3 more/);
  assert.match(r.out, /fail: 18 leftover volume/);
});

test("DEVOS-236: several purged applications, each with its own leftover, are all reported (pre-review 8)", () => {
  const vols = [{ Name: `${U1}-db`, Labels: {} }, { Name: "x-cache", Labels: { "com.docker.compose.project": U2 } }, { Name: "keep", Labels: {} }];
  const r = run({ cli: JSON.stringify({ uuids: [U1, U2], invalid: 0 }), vols });
  // A subset of the listed volumes is never accepted (Codex PR209-r1).
  const sub = run({ cli: JSON.stringify({ uuids: [U1, U2], invalid: 0 }), vols, inspect: JSON.stringify(vols.slice(2)) });
  assert.equal(sub.code, 1, sub.out);
  assert.match(sub.out, /fail: unreadable docker volume inspect output/);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`leftover volume: ${U1}-db \\(purged application ${U1}\\)`));
  assert.match(r.out, new RegExp(`leftover volume: x-cache \\(purged application ${U2}\\)`));
  assert.match(r.out, /fail: 2 leftover volume\(s\) of purged applications \(2 purged applications checked\)/);
});

test("DEVOS-236: Codex PR209-r4 — 2,000 purged applications with 64-character ids (the documented limit) are scanned, not refused", () => {
  const uuids = Array.from({ length: 2000 }, (_, i) => `u${String(i).padStart(4, "0")}`.padEnd(64, "a"));
  assert.ok(JSON.stringify(uuids).length > 131072, "the list must exceed one argument's limit to exercise the fix");
  const vols = [{ Name: `${uuids[1999]}-data`, Labels: null }, { Name: "other-volume", Labels: { x: "y" } }];
  const r = run({ cli: JSON.stringify({ uuids, invalid: 0 }), vols });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`leftover volume: ${uuids[1999]}-data \\(purged application ${uuids[1999]}\\)`));
  assert.match(r.out, /fail: 1 leftover volume\(s\) of purged applications \(2000 purged applications checked\)/);
  const clean = run({ cli: JSON.stringify({ uuids, invalid: 0 }), vols: [vols[1]] });
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /^ok: no leftover volume \(2000 purged applications checked\)/m);
});

test("DEVOS-236: Codex PR209-r5 — only the CLI's fixed error codes are printed; other error text never leaves the container", () => {
  const known = run({ cli: '{"error":"teardown-volumes-too-many-rows","max":2000}', cliRc: 1 });
  assert.equal(known.code, 1, known.out);
  assert.match(known.out, /^fail: the purged-application read failed \(exit 1\): teardown-volumes-too-many-rows$/m);
  const leak = run({ cli: '{"error":"password=Hunter2secretValue connection refused"}', cliRc: 1 });
  assert.equal(leak.code, 1, leak.out);
  assert.match(leak.out, /^fail: the purged-application read failed \(exit 1\): unrecognised error$/m);
  assert.doesNotMatch(leak.out, /Hunter2|password/);
  const none = run({ cli: "not json", cliRc: 1 });
  assert.match(none.out, /^fail: the purged-application read failed \(exit 1\): no output$/m);
});

test("DEVOS-236: Codex PR209-r6 — a successful read must print exactly one result; a second result or extra line fails", () => {
  const vols = [{ Name: `${U1}-data`, Labels: null }];
  const two = run({ cli: `{"uuids":[],"invalid":0}\n${JSON.stringify({ uuids: [U1], invalid: 0 })}`, vols });
  assert.equal(two.code, 1, two.out);
  assert.match(two.out, /^fail: unreadable purged-application list$/m);
  const extra = run({ cli: '{"uuids":[],"invalid":0}\nsome other line', vols });
  assert.equal(extra.code, 1, extra.out);
  assert.match(extra.out, /^fail: unreadable purged-application list$/m);
  const one = run({ cli: '{"uuids":[],"invalid":0}', vols });
  assert.equal(one.code, 0, one.out);
});

test("DEVOS-236: Codex PR209-r7 — two JSON values, on one line or in the inspect output, are malformed, never clean", () => {
  const vols = [{ Name: `${U1}-data`, Labels: null }];
  const twoOnOne = run({ cli: '{"uuids":[],"invalid":0} {"uuids":[],"invalid":0}', vols });
  assert.equal(twoOnOne.code, 1, twoOnOne.out);
  assert.match(twoOnOne.out, /^fail: unreadable purged-application list$/m);
  const notObject = run({ cli: '{"uuids":[],"invalid":0}'.replace(/^\{/, "[{").concat("]"), vols });
  assert.equal(notObject.code, 1, notObject.out);
  const live = [{ Name: "live-volume", Labels: null }];
  const twoArrays = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: live, inspect: `${JSON.stringify(live)}\n${JSON.stringify(live)}` });
  assert.equal(twoArrays.code, 1, twoArrays.out);
  assert.match(twoArrays.out, /^fail: unreadable docker volume inspect output$/m);
});

test("DEVOS-236: Codex PR209-r8 — a NUL byte in the CLI, volume ls or inspect output is malformed, never dropped into valid JSON", () => {
  const live = [{ Name: "live-volume", Labels: null }];
  const cli = run({ cli: '{\u0000"uuids":[],"invalid":0}', vols: live });
  assert.equal(cli.code, 1, cli.out);
  assert.match(cli.out, /^fail: unreadable purged-application list$/m);
  const ins = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: live, inspect: `[\u0000${JSON.stringify(live).slice(1)}` });
  assert.equal(ins.code, 1, ins.out);
  assert.match(ins.out, /^fail: unreadable docker volume inspect output$/m);
  const ls = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: [{ Name: "live\u0000volume", Labels: null }] });
  assert.equal(ls.code, 1, ls.out);
});

test("DEVOS-236: Codex PR209-r9 — a blank first docker ps line never hides a listed API container; other junk fails", () => {
  const vols = [{ Name: `${U1}-data`, Labels: null }];
  const blankFirst = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols, psOut: "\\nabcdef123456\\n" });
  assert.equal(blankFirst.code, 1, blankFirst.out);
  assert.match(blankFirst.out, new RegExp(`leftover volume: ${U1}-data`));
  const junk = run({ psOut: "abcdef123456\\nnot-an-id\\n" });
  assert.equal(junk.code, 1, junk.out);
  assert.match(junk.out, /^fail: unreadable docker ps output$/m);
  const none = run({ psOut: "\\n  \\n" });
  assert.equal(none.code, 3, none.out);
});

test("DEVOS-236: Codex PR209-r10 — a NUL byte in docker ps output fails, never turns into a blank line and a skip", () => {
  for (const psOut of ["\\0\\n", "\\0abcdef123456\\n", "abcdef123456\\0\\n"]) {
    const r = run({ psOut });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^fail: unreadable docker ps output$/m);
    assert.doesNotMatch(r.args, /^exec /m);
  }
});
