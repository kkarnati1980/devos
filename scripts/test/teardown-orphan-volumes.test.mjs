// DEVOS-236 (docs/modules/M2.5.md "DEVOS-236 decisions"): the read-only orphan-volume server check, on a fake `docker`.
// Fakes on PATH: `docker` (ps → one API id unless FAKE_API=0; exec → prints FAKE_DIR/cli and exits FAKE_CLI_RC;
// volume ls → prints FAKE_DIR/vols and exits FAKE_VOL_RC; anything else, e.g. `volume rm`, exits 99 and is recorded).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(ROOT, "scripts/server/checks/teardown-orphan-volumes.sh");

function run({ cli = '{"uuids":[],"invalid":0}', cliRc = 0, vols = "", volRc = 0, api = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "devos-orphan-"));
  fs.writeFileSync(path.join(bin, "cli"), cli + "\n");
  fs.writeFileSync(path.join(bin, "vols"), vols);
  fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/docker.args"
case "$1 \${2:-}" in
  "ps "*) [[ "$FAKE_API" == 1 ]] && echo abcdef123456; exit 0;;
  "exec "*) cat "$FAKE_DIR/cli"; exit "$FAKE_CLI_RC";;
  "volume ls") cat "$FAKE_DIR/vols"; exit "$FAKE_VOL_RC";;
esac
exit 99
`);
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [CHECK], {
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, FAKE_API: api ? "1" : "0", FAKE_CLI_RC: String(cliRc), FAKE_VOL_RC: String(volRc) },
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
  const vols = [`${U1}-postgres-data\tcoolify.managed=true`, `${U1}_uploads\t`, `${U1}\t`, `other-volume\tx=y`].join("\n") + "\n";
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`leftover volume: ${U1}-postgres-data \\(purged application ${U1}\\)`));
  assert.match(r.out, new RegExp(`leftover volume: ${U1}_uploads`));
  assert.match(r.out, /fail: 3 leftover volume\(s\) of purged applications \(1 purged applications checked\)/);
  assert.doesNotMatch(r.out, /other-volume/);
});

test("DEVOS-236: a volume whose label value is exactly a purged uuid is a hit; a partial or prefix match is not", () => {
  const vols = [
    `data_abc\tcom.docker.compose.project=${U2},coolify.managed=true`,
    `near1\tcom.docker.compose.project=${U2}x`,
    `near2\tnote=x${U2}`,
    `${U2}x-data\t`,
  ].join("\n") + "\n";
  const r = run({ cli: JSON.stringify({ uuids: [U2], invalid: 0 }), vols });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /leftover volume: data_abc/);
  assert.doesNotMatch(r.out, /near1|near2|abc123-def456x-data/);
  assert.match(r.out, /fail: 1 leftover volume/);
});

test("DEVOS-236: volumes of live applications only → pass, and the check never removes anything", () => {
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols: "liveapp0001-data\tcoolify.managed=true\n" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok: no leftover volume \(1 purged applications checked\)/);
  assert.doesNotMatch(r.args, /volume rm|volume prune|\brm\b/);
  assert.deepEqual(r.args.trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")), ["ps --filter", "exec abcdef123456", "volume ls"]);
});

test("DEVOS-236: rows the scan cannot match make it incomplete → fail, never clean", () => {
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 2 }) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail: 2 purged application row\(s\) have an id the scan cannot match/);
});

test("DEVOS-236: an unreadable or malformed list fails, never passes", () => {
  for (const cli of ["not json", '{"uuids":"x","invalid":0}', '{"uuids":[],"invalid":"0"}', '{"uuids":["a;b c"],"invalid":0}', '{"invalid":0}']) {
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
});

test("DEVOS-236: skipped when DevOS is not deployed or has no database", () => {
  let r = run({ api: false });
  assert.equal(r.code, 3);
  assert.match(r.out, /skipped: no running DevOS API container/);
  r = run({ cli: '{"code":"skipped"}', cliRc: 3 });
  assert.equal(r.code, 3);
  assert.match(r.out, /skipped: no database/);
});

test("DEVOS-236: names are printed in a fixed character set and the list stops at 15", () => {
  const vols = Array.from({ length: 18 }, (_, i) => `${U1}-v${i}$(id)\t`).join("\n") + "\n";
  const r = run({ cli: JSON.stringify({ uuids: [U1], invalid: 0 }), vols });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /\$\(id/);
  assert.equal((r.out.match(/leftover volume:/g) || []).length, 15);
  assert.match(r.out, /\.\.\. 3 more/);
  assert.match(r.out, /fail: 18 leftover volume/);
});
