// DEVOS-54 (M0.4 follow-up): scripts/phase0/lib/coolify-version.sh, the /version check shared by
// 04a and 04b. Contract: docs/modules/M0.4.md (AT1, "Follow-up DEVOS-54").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const LIB = path.resolve(import.meta.dirname, "../phase0/lib/coolify-version.sh");

function run(fn, ...args) {
  const r = spawnSync("bash", ["-c", `source "$0"; ${fn} "$@"`, LIB, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test("reads the version from a JSON string, a JSON object and a bare text body", () => {
  assert.equal(run("coolify_version", '"4.5.3"').out, "4.5.3");
  assert.equal(run("coolify_version", '{"version":"4.5.3"}').out, "4.5.3");
  assert.equal(run("coolify_version", "4.5.3\n").out, "4.5.3");
  assert.equal(run("coolify_version", '{"other":1}').out, "");
  assert.equal(run("coolify_version", "[1,2]").out, "");
});

test("AT1 passes for HTTP 200 and 4.5.x, including the JSON-object body that used to false-FAIL", () => {
  for (const body of ['"4.5.3"', '{"version":"4.5.3"}', '"v4.5.10"']) {
    const r = run("coolify_version_ok", "200", body);
    assert.equal(r.code, 0, `${body}: ${r.err}`);
    assert.match(r.out, /^v?4\.5\.\d+$/);
  }
});

test("AT1 fails on a non-200 status, another version, or an unreadable body", () => {
  const notOk = run("coolify_version_ok", "401", '"4.5.3"');
  assert.equal(notOk.code, 1);
  assert.match(notOk.out, /HTTP 401/);
  const other = run("coolify_version_ok", "200", '{"version":"4.6.0"}');
  assert.equal(other.code, 1);
  assert.match(other.out, /'4\.6\.0' is not 4\.5\.x/);
  const junk = run("coolify_version_ok", "200", "<html>login</html>");
  assert.equal(junk.code, 1);
  assert.match(junk.out, /is not 4\.5\.x/);
  assert.match(run("coolify_version_ok", "200", "[1,2]").out, /unreadable/);
});

test("04a and 04b both source the shared check and 04b checks /version before any write", async () => {
  const fs = await import("node:fs");
  const dir = path.resolve(import.meta.dirname, "../phase0");
  for (const f of ["04a-coolify-api-discover.sh", "04b-coolify-api-lifecycle.sh"]) {
    assert.match(fs.readFileSync(path.join(dir, f), "utf8"), /source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/lib\/coolify-version\.sh"/);
  }
  const b = fs.readFileSync(path.join(dir, "04b-coolify-api-lifecycle.sh"), "utf8");
  const versionAt = b.indexOf("api GET /version");
  const firstWrite = b.search(/api (POST|PATCH|DELETE) /);
  assert.ok(versionAt > 0 && versionAt < firstWrite, "version check must come before the first write call");
  assert.match(b, /no deployment_uuid - not polling/);
});
