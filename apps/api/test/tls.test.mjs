// R3-a acceptance tests (docs/modules/R3.md, DEVOS-81): the API serves HTTPS in process from the
// `tailscale cert` files (a throwaway self-signed pair here) and, with DEVOS_COOKIE_SECURE=1, refuses to
// start without them. Runs against the compiled app on a real socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../dist/app.js";
import { loadConfig, loadTls } from "../dist/config.js";

const ENV = {
  DEVOS_KK_LOGIN: "kk@example.com",
  DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef",
  DEVOS_ALLOWED_ORIGINS: "https://devos.example:3000",
};

function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), "r3-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  return { dir, cert, key };
}

function get(port, path, ca) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path, method: "GET", ca, servername: "localhost", agent: false }, (res) => {
      const protocol = res.socket?.getProtocol?.() ?? null;
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body, protocol }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("R3 AT1 the API serves HTTPS (TLS 1.2+, verified certificate, HSTS) from the certificate files", async () => {
  const { cert, key } = selfSigned();
  const env = { ...ENV, DEVOS_COOKIE_SECURE: "1", DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: key };
  const config = loadConfig(env);
  const tls = loadTls(env, config.secureCookies);
  assert.ok(tls, "TLS loaded");
  const app = await createApp({ config, identity: { whois: async () => null }, grants: null, log: () => {}, tls });
  await app.listen(0, "127.0.0.1");
  try {
    const port = app.getHttpServer().address().port;
    const r = await get(port, "/health", readFileSync(cert));
    assert.equal(r.status, 200);
    assert.match(r.protocol ?? "", /^TLSv1\.[23]$/);
    assert.match(r.headers["strict-transport-security"] ?? "", /max-age=\d+/);
    // A plain-HTTP request to the TLS port gets no HTTP answer.
    const plain = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `http://127.0.0.1:${port}/health`], { encoding: "utf8" });
    assert.notEqual(plain.stdout, "200");
    // An unknown CA is rejected (verification stays on for clients).
    await assert.rejects(get(port, "/health", undefined), /self[- ]signed|unable to verify|certificate/i);
  } finally {
    await app.close();
  }
});

test("R3 AT2 with DEVOS_COOKIE_SECURE=1 the API refuses to start without both readable files (config-tls-required)", () => {
  const { dir, cert, key } = selfSigned();
  const empty = join(dir, "empty.pem");
  writeFileSync(empty, "");
  const gone = join(dir, "missing.pem");
  for (const files of [{}, { DEVOS_TLS_CERT_FILE: cert }, { DEVOS_TLS_KEY_FILE: key }, { DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: gone },
    { DEVOS_TLS_CERT_FILE: empty, DEVOS_TLS_KEY_FILE: key }]) {
    assert.throws(() => loadTls({ ...ENV, ...files }, true), { message: "config-tls-required" }, JSON.stringify(Object.keys(files)));
  }
});

test("R3 AT2 with 0/unset: no files = plain HTTP; half a pair or an unreadable file stops start-up", () => {
  const { dir, cert, key } = selfSigned();
  assert.equal(loadTls({ ...ENV }, false), null);
  assert.equal(loadTls({ ...ENV, DEVOS_TLS_CERT_FILE: "", DEVOS_TLS_KEY_FILE: "" }, false), null);
  assert.throws(() => loadTls({ ...ENV, DEVOS_TLS_CERT_FILE: cert }, false), { message: "config-tls-incomplete" });
  assert.throws(() => loadTls({ ...ENV, DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: join(dir, "x.pem") }, false), { message: "config-tls-unreadable" });
  assert.ok(loadTls({ ...ENV, DEVOS_TLS_CERT_FILE: cert, DEVOS_TLS_KEY_FILE: key }, false));
});

test("R3 AT2 the real entry point exits 1 with only the code config-tls-required, never the path", () => {
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  const secretPath = join(tmpdir(), "secret-name-cert.pem");
  const r = spawnSync(process.execPath, [main], {
    env: { PATH: process.env.PATH, ...ENV, PORT: "3999", DEVOS_COOKIE_SECURE: "1", DEVOS_TLS_CERT_FILE: secretPath, DEVOS_TLS_KEY_FILE: secretPath },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /"code":"config-tls-required"/);
  assert.ok(!(r.stdout + r.stderr).includes("secret-name-cert"), "no path in the log");
});
