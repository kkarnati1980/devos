// M1.3 AT6: HTTPS decision (M1.3-a). TLS in process from certificate files
// (`tailscale cert` output on the server; a throwaway self-signed pair here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { startDashboard } from "./helpers.mjs";
import { readServerConfig } from "../server.mjs";

function httpsGet(url, ca) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca, servername: "localhost", timeout: 10_000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

test("AT6 (PS) HTTPS: served over TLS from certificate files with HSTS; half a TLS config refuses to start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m13-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const dash = await startDashboard({ DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: key });
  try {
    assert.ok(dash.base.startsWith("https://"));
    const { readFileSync } = await import("node:fs");
    const res = await httpsGet(dash.base + "/", readFileSync(cert));
    assert.equal(res.status, 200);
    assert.equal(res.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
    assert.ok(res.headers["content-security-policy"]);
    assert.equal((res.body.match(/data-testid="project-card"/g) ?? []).length, 20);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => readServerConfig({ DEVOS_TLS_CERT_FILE: cert }), /config-tls-incomplete/);
  assert.throws(() => readServerConfig({ DEVOS_TLS_KEY_FILE: key }), /config-tls-incomplete/);
  assert.throws(() => readServerConfig({ PORT: "99999" }), /config-port-invalid/);
  assert.equal(readServerConfig({}).host, "127.0.0.1");
});
