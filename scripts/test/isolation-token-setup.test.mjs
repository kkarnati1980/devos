// DEVOS-237 (S4-t1): scripts/server/isolation-token-setup.sh against a fake `curl` that plays the Coolify envs API.
// Contract: docs/modules/S4.md ("S4-t1 decisions").
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/server/isolation-token-setup.sh");
const UUID = "app-1234abcd";
const CF_SECRET = "cf-fake-" + "0".repeat(12); // built at run time: no key-shaped literal (DEVOS-197)
let tmp, bin;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-isotok-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  // curl: logs argv; GET .../envs prints $FAKE_ENVS (FAKE_GET_CODE, default 200); PATCH .../envs/bulk copies the
  // body to $FAKE_LOG/patch.N.json and, on success, merges it into $FAKE_ENVS (FAKE_PATCH_CODE, default 201;
  // FAKE_HIDE_VALUES=1 drops values on read, like a token without read:sensitive; FAKE_FLIP_BUILD=1 stores
  // is_buildtime:true whatever was sent). Headers given as @file are copied to $FAKE_LOG/headers.
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG/curl.args"
[[ "\${FAKE_CURL_RC:-0}" == 0 ]] || { printf 000; exit "$FAKE_CURL_RC"; }
out= m=GET url= body=
while (( $# )); do case "$1" in
  -o) out="$2"; shift 2 ;; -X) m="$2"; shift 2 ;; -w) shift 2 ;;
  -H) [[ "$2" == @* ]] && cat "\${2#@}" >> "$FAKE_LOG/headers"; shift 2 ;;
  --data-binary) body="\${2#@}"; shift 2 ;; --connect-timeout|--max-time) shift 2 ;;
  -*) shift ;; *) url="$1"; shift ;;
esac; done
case "$m $url" in
  "GET "*/envs) code="\${FAKE_GET_CODE:-200}"
    if [[ "\${FAKE_HIDE_VALUES:-0}" == 1 ]]; then jq 'map(del(.value))' "$FAKE_ENVS" > "$out"; else cat "$FAKE_ENVS" > "$out"; fi ;;
  "PATCH "*/envs/bulk) code="\${FAKE_PATCH_CODE:-201}"; n=$(ls "$FAKE_LOG" | grep -c '^patch\\.'); cp "$body" "$FAKE_LOG/patch.$n.json"
    if [[ "$code" == 201 ]]; then
      jq -s --arg f "\${FAKE_FLIP_BUILD:-0}" --arg o "\${FAKE_ALTER:-}" '.[1].data[0] as $e | ($e | if $f == "1" then (if has("is_buildtime") then .is_buildtime = true else .is_build_time = true end) else . end
          | if $o == "value" then .value = "other" elif $o == "preview" then .is_preview = true else . end) as $e
        | [.[0][] | select(.key != $e.key)] + [$e]' "$FAKE_ENVS" "$body" > "$FAKE_ENVS.n" && mv "$FAKE_ENVS.n" "$FAKE_ENVS"
    fi; echo '{}' > "$out" ;;
  *) code=404; echo '{}' > "$out" ;;
esac
printf '%s' "$code"`);
  fs.chmodSync(path.join(bin, "curl"), 0o755);
});

const NEW_ENVS = [{ key: "GIT_SHA", value: "abc", is_preview: false, is_buildtime: true, is_runtime: true }];
const OLD_ENVS = [{ key: "GIT_SHA", value: "abc", is_preview: false, is_build_time: true }];

function host({ cf = true, envs = NEW_ENVS, token } = {}) {
  const h = fs.mkdtempSync(path.join(tmp, "h-"));
  fs.mkdirSync(path.join(h, "log"));
  fs.mkdirSync(path.join(h, "devos"), { mode: 0o700 });
  if (cf) fs.writeFileSync(path.join(h, "devos/coolify-deploy.env"), `COOLIFY_TOKEN=${CF_SECRET}\nCOOLIFY_APP_UUID=${UUID}\n`, { mode: 0o600 });
  if (token !== undefined) {
    fs.mkdirSync(path.join(h, "devos/secrets"), { mode: 0o700 });
    fs.writeFileSync(path.join(h, "devos/secrets/isolation_state_token"), token, { mode: 0o644 });
  }
  fs.writeFileSync(path.join(h, "envs.json"), JSON.stringify(envs));
  return h;
}
function run(h, args = [], env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, DEVOS_DIR: path.join(h, "devos"),
    FAKE_LOG: path.join(h, "log"), FAKE_ENVS: path.join(h, "envs.json"), LOCK_WAIT: "2", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
const tokFile = (h) => path.join(h, "devos/secrets/isolation_state_token");
const tok = (h) => fs.readFileSync(tokFile(h), "utf8");
const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
const envs = (h) => JSON.parse(fs.readFileSync(path.join(h, "envs.json"), "utf8"));
const patches = (h) => fs.readdirSync(path.join(h, "log")).filter((f) => f.startsWith("patch.")).length;
const logText = (h) => fs.readdirSync(path.join(h, "log")).filter((f) => f !== "headers" && !f.startsWith("patch."))
  .map((f) => fs.readFileSync(path.join(h, "log", f), "utf8")).join("\n");

test("creates a 64-character token (dir 700, file 600) and sets a runtime-only Coolify env with that value", () => {
  const h = host();
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  const t = tok(h);
  assert.match(t, /^[A-Za-z0-9+/=]{64}\n$/);
  assert.equal(mode(tokFile(h)), "600");
  assert.equal(mode(path.join(h, "devos/secrets")), "700");
  const e = envs(h).find((x) => x.key === "DEVOS_ISOLATION_STATE_TOKEN");
  assert.deepEqual(e, { key: "DEVOS_ISOLATION_STATE_TOKEN", value: t.trim(), is_preview: false, is_buildtime: false, is_runtime: true });
  assert.ok(envs(h).some((x) => x.key === "GIT_SHA"), "other envs untouched");
  assert.match(r.out, /host token: created/);
  assert.match(r.out, /DEVOS_ISOLATION_STATE_TOKEN set/);
  // never on argv, stdout or stderr; the Coolify token only in the header file
  assert.ok(!r.out.includes(t.trim()), "token not printed");
  assert.ok(!logText(h).includes(t.trim()), "token not on curl's argv");
  assert.ok(!logText(h).includes(CF_SECRET), "Coolify token not on argv");
  assert.match(fs.readFileSync(path.join(h, "log/headers"), "utf8"), new RegExp(`Authorization: Bearer ${CF_SECRET}`));
  assert.equal(fs.readdirSync(path.join(h, "devos/secrets")).length, 1, "no temp file left behind");
});

test("keeps an existing valid token (re-run is idempotent) and replaces it only with --rotate", () => {
  const keep = "K".repeat(40) + "\n";
  const h = host({ token: keep });
  let r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.equal(tok(h), keep);
  assert.equal(mode(tokFile(h)), "600", "mode tightened");
  assert.match(r.out, /host token: kept/);
  assert.equal(envs(h).find((x) => x.key === "DEVOS_ISOLATION_STATE_TOKEN").value, "K".repeat(40));
  r = run(h, ["--rotate"]);
  assert.equal(r.code, 0, r.out);
  assert.notEqual(tok(h), keep);
  assert.equal(envs(h).find((x) => x.key === "DEVOS_ISOLATION_STATE_TOKEN").value, tok(h).trim());
  assert.equal(envs(h).filter((x) => x.key === "DEVOS_ISOLATION_STATE_TOKEN").length, 1);
});

test("a token of exactly 32 characters is kept", () => {
  const keep = "Q".repeat(32) + "\n";
  const h = host({ token: keep });
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  assert.equal(tok(h), keep);
});

test("a malformed or short host token is replaced", () => {
  for (const bad of ["short-token\n", "x".repeat(31), "bad token with spaces and more than thirty two chars\n", ""]) {
    const h = host({ token: bad });
    const r = run(h);
    assert.equal(r.code, 0, r.out);
    assert.match(tok(h), /^[A-Za-z0-9+/=]{64}\n$/, JSON.stringify(bad));
  }
});

test("older Coolify (is_build_time only) gets is_build_time:false", () => {
  const h = host({ envs: OLD_ENVS });
  const r = run(h);
  assert.equal(r.code, 0, r.out);
  const e = envs(h).find((x) => x.key === "DEVOS_ISOLATION_STATE_TOKEN");
  assert.deepEqual(Object.keys(e).sort(), ["is_build_time", "is_preview", "key", "value"]);
  assert.equal(e.is_build_time, false);
});

test("values hidden on read (no read:sensitive): presence and flags are checked", () => {
  const h = host();
  const r = run(h, [], { FAKE_HIDE_VALUES: "1" });
  assert.equal(r.code, 0, r.out);
});

test("no Coolify token yet: host token written, Coolify skipped, exit 3", () => {
  const h = host({ cf: false });
  const r = run(h);
  assert.equal(r.code, 3, r.out);
  assert.match(tok(h), /^[A-Za-z0-9+/=]{64}\n$/);
  assert.match(r.out, /skipped: no Coolify token stored yet/);
  assert.equal(fs.existsSync(path.join(h, "log/curl.args")), false, "no request made");
});

test("Coolify errors exit 1 and keep the host token; a read-back with build-time on fails", () => {
  for (const [env, re] of [[{ FAKE_GET_CODE: "403" }, /reading the app's env: HTTP 403/], [{ FAKE_PATCH_CODE: "401" }, /writing the app's env: HTTP 401/],
    [{ FAKE_PATCH_CODE: "500" }, /writing the app's env: Coolify API answered HTTP 500/], [{ FAKE_FLIP_BUILD: "1" }, /did not read back as a runtime-only env/],
    [{ FAKE_ALTER: "value" }, /did not read back as a runtime-only env with the host's value/], [{ FAKE_ALTER: "preview" }, /did not read back/],
    [{ FAKE_CURL_RC: "7" }, /reading the app's env: Coolify API not reachable/]]) {
    const keep = "Z".repeat(48) + "\n";
    const h = host({ token: keep });
    const r = run(h, [], env);
    assert.equal(r.code, 1, `${JSON.stringify(env)}: ${r.out}`);
    assert.match(r.out, re);
    assert.equal(tok(h), keep, "host token kept");
  }
});

test("waits for the agent lock and gives up without sending anything", () => {
  const h = host();
  const lock = path.join(h, "devos/agent/agent.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  const holder = spawnSync("bash", ["-c", `exec 9>>"${lock}"; flock 9; bash "${SCRIPT}"; echo "rc=$?"`], { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, DEVOS_DIR: path.join(h, "devos"), FAKE_LOG: path.join(h, "log"), FAKE_ENVS: path.join(h, "envs.json"), LOCK_WAIT: "1" } });
  assert.match(holder.stdout, /the agent tick did not finish/);
  assert.match(holder.stdout, /rc=1/);
  assert.equal(patches(h), 0);
});

test("bad COOLIFY_APP_UUID and unknown arguments are refused", () => {
  const h = host();
  fs.writeFileSync(path.join(h, "devos/coolify-deploy.env"), "COOLIFY_TOKEN=x\nCOOLIFY_APP_UUID=../../x\n");
  let r = run(h);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no valid COOLIFY_APP_UUID/);
  assert.equal(run(h, ["--force"]).code, 2);
  assert.equal(run(h, ["--rotate", "x"]).code, 2);
});
