#!/usr/bin/env node
// R1-b (PR20-r1): build DATABASE_URL from the Postgres settings with the password URL-encoded, then run the
// service command with it. A password with reserved characters (`#`, `/`, `@`, `:`, `%`, …) therefore always
// gives a valid URL. No value is ever printed. Usage: node with-db-url.mjs <command> [args…]
// PR20-r2: compose passes an unset optional setting as an empty string (`${NAME:-}`). The services treat
// "unset" and "empty" differently in places (e.g. the M1.6 SMTP port/security defaults), so every empty
// DEVOS_* variable is removed before the command starts: empty always means "not set".
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Pure: the child environment — empty DEVOS_* settings removed, the raw password dropped, the URL added. */
export function childEnv(env, url) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "POSTGRES_PASSWORD") continue;
    if (k.startsWith("DEVOS_") && v === "") continue;
    out[k] = v;
  }
  out.DATABASE_URL = url;
  return out;
}

/** Pure: the connection URL for these settings. Throws a `config-*` code (never a value). */
export function databaseUrl(env) {
  const password = env.POSTGRES_PASSWORD ?? "";
  if (!password) throw new Error("config-postgres-password-required");
  const user = env.POSTGRES_USER || "devos";
  const host = env.POSTGRES_HOST || "postgres";
  const port = env.POSTGRES_PORT || "5432";
  const db = env.POSTGRES_DB || "devos";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user) || !/^[a-z_][a-z0-9_]{0,62}$/.test(db)) throw new Error("config-postgres-name-invalid");
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) throw new Error("config-postgres-host-invalid");
  if (!/^[0-9]{2,5}$/.test(port)) throw new Error("config-postgres-port-invalid");
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  let url;
  try {
    if (!cmd) throw new Error("config-command-required");
    url = databaseUrl(process.env);
  } catch (e) {
    const code = e instanceof Error && /^config-[a-z-]+$/.test(e.message) ? e.message : "startup-failed";
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "db-url-failed", code }));
    process.exit(1);
  }
  // The child gets the URL; the raw password is not passed on; empty optional settings are unset.
  const child = spawn(cmd, args, { stdio: "inherit", env: childEnv(process.env, url) });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
  child.on("error", () => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "db-url-spawn-failed" }));
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
