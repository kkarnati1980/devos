// M1.3 production server. HTTPS decision (ADR-0011 §6, contract M1.3-a): TLS is
// terminated in this process with the certificate from `tailscale cert`; no
// Traefik hop (it would hide the tailnet peer address M1.2's whois needs) and no
// Tailscale Serve (ADR-0005). Without certificate files it serves plain HTTP
// (local tests, CI).
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import next from "next";
import { HSTS } from "./lib/headers.mjs";

export function readServerConfig(env = process.env) {
  const cert = env.DEVOS_TLS_CERT_FILE || "";
  const key = env.DEVOS_TLS_KEY_FILE || "";
  if (Boolean(cert) !== Boolean(key)) throw Object.assign(new Error("config-tls-incomplete"), { code: "config-tls-incomplete" });
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Object.assign(new Error("config-port-invalid"), { code: "config-port-invalid" });
  return { tls: cert ? { cert, key } : null, port, host: env.HOST || "127.0.0.1" };
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
    ? createHttps({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key), minVersion: "TLSv1.2" }, onRequest)
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
