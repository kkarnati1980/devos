// M1.3 production server. HTTPS decision (ADR-0011 §6, contract M1.3-a): TLS is
// terminated in this process with the certificate from `tailscale cert`; no
// Traefik hop (it would hide the tailnet peer address M1.2's whois needs) and no
// Tailscale Serve (ADR-0005). Plain HTTP only when DEVOS_COOKIE_SECURE is 0 or
// unset (local tests, CI). With DEVOS_COOKIE_SECURE=1 (the server default) it
// refuses to start unless both TLS files can be read (DEVOS-84, config-tls-required).
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import next from "next";
import { HSTS } from "./lib/headers.mjs";

const configError = (code) => Object.assign(new Error(code), { code });

/** File contents, or null when the path cannot be read as a non-empty regular file. Never logs. */
function readPem(path) {
  try {
    const buf = readFileSync(path);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export function readServerConfig(env = process.env) {
  const cert = env.DEVOS_TLS_CERT_FILE || "";
  const key = env.DEVOS_TLS_KEY_FILE || "";
  // Same rule as M1.2 (PR14-r2): only "1" (on) or "0"/unset (off); a typo never drops TLS.
  const rawSecure = env.DEVOS_COOKIE_SECURE;
  if (rawSecure !== undefined && rawSecure !== "" && rawSecure !== "0" && rawSecure !== "1") throw configError("config-cookie-secure-invalid");
  const secure = rawSecure === "1";
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw configError("config-port-invalid");
  let tls = null;
  if (secure) {
    // DEVOS-84: secure cookies need HTTPS; never fall back to plain HTTP.
    const certPem = cert ? readPem(cert) : null;
    const keyPem = key ? readPem(key) : null;
    if (!certPem || !keyPem) throw configError("config-tls-required");
    tls = { cert: certPem, key: keyPem };
  } else {
    if (Boolean(cert) !== Boolean(key)) throw configError("config-tls-incomplete");
    if (cert) {
      const certPem = readPem(cert);
      const keyPem = readPem(key);
      if (!certPem || !keyPem) throw configError("config-tls-unreadable");
      tls = { cert: certPem, key: keyPem };
    }
  }
  return { tls, secure, port, host: env.HOST || "127.0.0.1" };
}

export async function start(env = process.env) {
  const cfg = readServerConfig(env);
  const app = next({ dev: false, dir: dirname(fileURLToPath(import.meta.url)) });
  await app.prepare();
  const handle = app.getRequestHandler();
  const onRequest = (req, res) => {
    if (cfg.tls) res.setHeader("Strict-Transport-Security", HSTS);
    handle(req, res);
  };
  const server = cfg.tls
    ? createHttps({ cert: cfg.tls.cert, key: cfg.tls.key, minVersion: "TLSv1.2" }, onRequest)
    : createHttp(onRequest);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  return { server, app, cfg };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().then(
    ({ cfg }) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "dashboard-listening", port: cfg.port, tls: Boolean(cfg.tls) })),
    (err) => {
      const code = typeof err?.code === "string" && /^config-[a-z-]+$/.test(err.code) ? err.code : "startup-failed";
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: code }));
      process.exit(1);
    },
  );
}
