// M1.3 AT10 (DEVOS-84): with DEVOS_COOKIE_SECURE=1 (the server default) the dashboard
// refuses to start unless it can read both TLS files; it never falls back to plain HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:https";
import { startDashboard } from "./helpers.mjs";
import { readServerConfig, start } from "../server.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

function selfSigned(dir) {
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  return { cert, key };
}

function httpsStatus(url, ca) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca, servername: "localhost", timeout: 10_000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

test("AT10a (DEVOS-84): secure cookies with no, half, missing, empty or directory TLS paths → config-tls-required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m13-tlsreq-"));
  try {
    const { cert, key } = selfSigned(dir);
    const empty = join(dir, "empty.pem");
    writeFileSync(empty, "");
    const gone = join(dir, "missing.pem");
    const cases = [
      {},
      { DEVOS_TLS_CERT_FILE: "", DEVOS_TLS_KEY_FILE: "" },
      { DEVOS_TLS_CERT_FILE: cert },
      { DEVOS_TLS_KEY_FILE: key },
      { DEVOS_TLS_CERT_FILE: gone, DEVOS_TLS_KEY_FILE: key },
      { DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: gone },
      { DEVOS_TLS_CERT_FILE: empty, DEVOS_TLS_KEY_FILE: key },
      { DEVOS_TLS_CERT_FILE: dir, DEVOS_TLS_KEY_FILE: key },
    ];
    for (const extra of cases) {
      assert.throws(() => readServerConfig({ DEVOS_COOKIE_SECURE: "1", ...extra }), { code: "config-tls-required" }, JSON.stringify(extra));
      // start() fails before Next.js is prepared or any port is bound.
      await assert.rejects(start({ DEVOS_COOKIE_SECURE: "1", HOST: "127.0.0.1", PORT: "0", ...extra }), { code: "config-tls-required" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AT10b (DEVOS-84): the real entry point exits 1 and logs only the code, never a path or file contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "m13-tlsreq-"));
  try {
    const gone = join(dir, "secret-name-cert.pem");
    const r = spawnSync(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, DEVOS_COOKIE_SECURE: "1", DEVOS_TLS_CERT_FILE: gone, DEVOS_TLS_KEY_FILE: gone, HOST: "127.0.0.1", PORT: "0" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    const line = JSON.parse(r.stderr.trim());
    assert.equal(line.level, "error");
    assert.equal(line.msg, "config-tls-required");
    assert.ok(!r.stderr.includes("secret-name-cert"), "no path in the log");
    assert.ok(!r.stderr.includes(dir), "no directory in the log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AT10c (DEVOS-84): secure cookies with readable TLS files → starts on HTTPS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m13-tlsreq-"));
  try {
    const { cert, key } = selfSigned(dir);
    const dash = await startDashboard({ DEVOS_COOKIE_SECURE: "1", DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: key });
    try {
      assert.ok(dash.base.startsWith("https://"));
      assert.equal(await httpsStatus(dash.base + "/", readFileSync(cert)), 200);
    } finally {
      await dash.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AT10d (DEVOS-84): DEVOS_COOKIE_SECURE=0 or unset still allows plain HTTP; any other value stops start-up", async () => {
  for (const env of [{ DEVOS_COOKIE_SECURE: "0" }, { DEVOS_COOKIE_SECURE: "" }, {}]) {
    const cfg = readServerConfig(env);
    assert.equal(cfg.tls, null);
    assert.equal(cfg.secure, false);
  }
  const dash = await startDashboard({ DEVOS_COOKIE_SECURE: "0" });
  try {
    assert.ok(dash.base.startsWith("http://"));
    const res = await fetch(dash.base + "/", { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  } finally {
    await dash.close();
  }
  for (const bad of ["true", "yes", "on", "2", " 1"]) {
    assert.throws(() => readServerConfig({ DEVOS_COOKIE_SECURE: bad }), { code: "config-cookie-secure-invalid" }, bad);
  }
  // Without secure cookies, unreadable TLS paths are a config error, not a raw fs error.
  assert.throws(() => readServerConfig({ DEVOS_TLS_CERT_FILE: "/nonexistent/c.pem", DEVOS_TLS_KEY_FILE: "/nonexistent/k.pem" }), { code: "config-tls-unreadable" });
});
