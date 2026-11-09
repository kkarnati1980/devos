// DEVOS-87 (R3-d): scripts/server/cert-renew.sh against a fake `tailscale` and a fake `docker`, with real
// openssl-made certificates. Contract: docs/modules/R3.md (R3-d).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/server/cert-renew.sh");
const HOST = "devos.tail1234.ts.net";
let tmp, bin;
const pairs = {};

function mkPair(name, cn = HOST) {
  const d = path.join(tmp, "pairs", name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", path.join(d, "k"), "-out", path.join(d, "c"), "-days", "90", "-subj", `/CN=${cn}`,
    "-addext", `subjectAltName=DNS:${cn}`], { stdio: "ignore" });
  return { c: path.join(d, "c"), k: path.join(d, "k") };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-cert-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  // tailscale: status --json gives the MagicDNS name; cert copies the FAKE_C/FAKE_K pair to --cert-file/--key-file.
  w("tailscale", `case "$1" in
  status) printf '{"Self":{"DNSName":"%s."}}' "$FAKE_DNS" ;;
  cert) echo "$*" >> "$FAKE_LOG/ts.args"; [[ "$FAKE_TS_RC" == 0 ]] || { echo "cert: rate limited"; exit "$FAKE_TS_RC"; }
        shift; while [[ $# -gt 1 ]]; do case "$1" in --cert-file) cf="$2"; shift 2;; --key-file) kf="$2"; shift 2;; *) shift;; esac; done
        cp "$FAKE_C" "$cf"; cp "$FAKE_K" "$kf"; chmod 600 "$kf" ;;
esac`);
  // docker: ps answers per label from FAKE_IDS_<svc>; restart is logged and fails when FAKE_RESTART_RC != 0.
  w("docker", `case "$1" in
  ps) svc="$(printf '%s\\n' "$@" | sed -n 's/^label=io.devos.service=//p')"; v="FAKE_IDS_$svc"; printf '%s\\n' \${!v:-} | sed '/^$/d' ;;
  restart) echo "restart $2" >> "$FAKE_LOG/docker.log"; exit "\${FAKE_RESTART_RC:-0}" ;;
esac`);
  pairs.old = mkPair("old");
  pairs.new = mkPair("new");
  pairs.other = mkPair("other", "other.tail1234.ts.net");
  // a certificate file that does not parse (stands in for an expired one: the same -checkend 0 test refuses both)
  const bad = path.join(tmp, "pairs", "bad"); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "c"), "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n");
  fs.copyFileSync(pairs.new.k, path.join(bad, "k"));
  pairs.bad = { c: path.join(bad, "c"), k: path.join(bad, "k") };
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup({ current = "old" } = {}) {
  const d = fs.mkdtempSync(path.join(tmp, "run-"));
  const tls = path.join(d, "tls");
  fs.mkdirSync(tls); fs.mkdirSync(path.join(d, "agent"));
  fs.copyFileSync(pairs[current].c, path.join(tls, "dashboard.crt")); fs.chmodSync(path.join(tls, "dashboard.crt"), 0o644);
  fs.copyFileSync(pairs[current].k, path.join(tls, "dashboard.key")); fs.chmodSync(path.join(tls, "dashboard.key"), 0o640);
  return d;
}
function run(d, { from = "new", tsRc = 0, restartRc = 0, ids = { api: "aaaaaaaaaaaa", dashboard: "bbbbbbbbbbbb" }, dns = HOST, env = {} } = {}) {
  const pair = pairs[from];
  const out = execFileSync("bash", ["-c", `bash "${SCRIPT}" 2>&1; echo "rc=$?"`], {
    env: { PATH: `${bin}:${process.env.PATH}`, DEVOS_DIR: d, DEVOS_TLS_DIR: path.join(d, "tls"), FAKE_LOG: d, FAKE_C: pair.c, FAKE_K: pair.k,
      FAKE_TS_RC: String(tsRc), FAKE_RESTART_RC: String(restartRc), FAKE_DNS: dns, FAKE_IDS_api: ids.api || "", FAKE_IDS_dashboard: ids.dashboard || "", ...env },
    encoding: "utf8",
  });
  const read = (f) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), "utf8") : "");
  return { code: Number(out.match(/rc=(\d+)\s*$/)[1]), out, docker: read("docker.log"), ts: read("ts.args") };
}
const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
const tlsFile = (d, n) => path.join(d, "tls", n);
const mode = (f) => fs.statSync(f).mode & 0o777;

test("R3-d AT6: a renewed certificate replaces both files (owner and mode kept) and restarts the api and the dashboard", () => {
  const d = setup();
  const r = run(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.ts, new RegExp(`cert --cert-file \\S+ --key-file \\S+ ${HOST.replace(/\./g, "\\.")}`));
  assert.ok(same(tlsFile(d, "dashboard.crt"), pairs.new.c), "new certificate in place");
  assert.ok(same(tlsFile(d, "dashboard.key"), pairs.new.k), "new key in place");
  assert.equal(mode(tlsFile(d, "dashboard.crt")), 0o644);
  assert.equal(mode(tlsFile(d, "dashboard.key")), 0o640, "the key keeps the old mode, not tailscale's 600");
  assert.equal(r.docker, "restart aaaaaaaaaaaa\nrestart bbbbbbbbbbbb\n");
  assert.match(r.out, /renewed \(valid until/);
  assert.doesNotMatch(r.out, /PRIVATE KEY/);
  assert.deepEqual(fs.readdirSync(path.join(d, "tls")).sort(), ["dashboard.crt", "dashboard.key"], "temp dir removed");
  assert.ok(!fs.existsSync(path.join(d, "agent/cert-restart-pending")));
});

test("R3-d AT7: unchanged files restart nothing", () => {
  const d = setup({ current: "new" });
  const r = run(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unchanged/);
  assert.equal(r.docker, "", "no restart");
});

test("R3-d AT8: a failed `tailscale cert`, or a bad new pair, changes nothing and restarts nothing", () => {
  for (const [opts, re] of [[{ tsRc: 1 }, /tailscale cert failed/], [{ from: "other" }, /does not name/], [{ from: "bad" }, /does not parse or is expired/]]) {
    const d = setup();
    const r = run(d, opts);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
    assert.ok(same(tlsFile(d, "dashboard.crt"), pairs.old.c) && same(tlsFile(d, "dashboard.key"), pairs.old.k), "files unchanged");
    assert.equal(r.docker, "");
  }
  // certificate and key that do not belong together
  const mix = path.join(tmp, "pairs", "mix"); fs.mkdirSync(mix, { recursive: true });
  fs.copyFileSync(pairs.new.c, path.join(mix, "c")); fs.copyFileSync(pairs.old.k, path.join(mix, "k"));
  pairs.mix = { c: path.join(mix, "c"), k: path.join(mix, "k") };
  const d = setup();
  const r = run(d, { from: "mix" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /do not match/);
  assert.ok(same(tlsFile(d, "dashboard.crt"), pairs.old.c));
});

test("R3-d AT9: a failed restart is retried by the next run even though the files are then unchanged", () => {
  const d = setup();
  const r1 = run(d, { restartRc: 1 });
  assert.equal(r1.code, 1, r1.out);
  assert.ok(same(tlsFile(d, "dashboard.crt"), pairs.new.c), "files were renewed");
  assert.ok(fs.existsSync(path.join(d, "agent/cert-restart-pending")));
  const r2 = run(d);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /earlier restart failed; restarting now/);
  assert.ok(!fs.existsSync(path.join(d, "agent/cert-restart-pending")));
  // no running container to restart is a failure too (it would keep the old certificate in memory)
  const d2 = setup();
  const r3 = run(d2, { ids: { api: "aaaaaaaaaaaa" } });
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /no running dashboard container/);
});

test("R3-d AT10: skipped before the first certificate exists; ambiguous file names fail until TLS_CERT_NAME is set", () => {
  const d = setup();
  fs.rmSync(path.join(d, "tls"), { recursive: true });
  assert.equal(run(d).code, 3);
  const d2 = setup();
  fs.copyFileSync(pairs.old.c, tlsFile(d2, "extra.crt"));
  const r = run(d2);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /TLS_CERT_NAME/);
  fs.writeFileSync(path.join(d2, "server-agent.conf"), "TLS_CERT_NAME=dashboard.crt\n");
  const r2 = run(d2);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(same(tlsFile(d2, "extra.crt"), pairs.old.c), "the other file is left alone");
  assert.ok(same(tlsFile(d2, "dashboard.crt"), pairs.new.c));
  assert.equal(run(setup(), { dns: "" }).code, 1, "no MagicDNS name fails");
});
