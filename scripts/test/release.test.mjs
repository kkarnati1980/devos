// R1 AT3 (static half): deploy/compose.yaml and the Dockerfile keep the R1-b deploy rules
// (docs/modules/R1.md). The live half (compose config refuses a missing DEVOS_BIND_IP, images carry no
// secret) runs in .github/workflows/release-images.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { childEnv, databaseUrl } from "../../deploy/with-db-url.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const composeText = readFileSync(`${root}deploy/compose.yaml`, "utf8");
const compose = parse(composeText, { merge: true });
const dockerfile = readFileSync(`${root}Dockerfile`, "utf8");
const dockerignore = readFileSync(`${root}.dockerignore`, "utf8");

test("AT3 the stack has exactly the R1-b services", () => {
  assert.deepEqual(Object.keys(compose.services).sort(), ["api", "dashboard", "migrate", "postgres", "redis", "worker"]);
});

test("AT3 only api and dashboard publish ports, each on the required DEVOS_BIND_IP", () => {
  for (const [name, svc] of Object.entries(compose.services)) {
    const ports = svc.ports ?? [];
    if (name === "api" || name === "dashboard") {
      assert.equal(ports.length, 1, `${name} publishes one port`);
      assert.match(String(ports[0]), /^\$\{DEVOS_BIND_IP:\?[^}]*\}:/, `${name} binds only to the required DEVOS_BIND_IP`);
    } else {
      assert.equal(ports.length, 0, `${name} publishes nothing`);
      assert.equal(svc.network_mode, undefined, `${name} is not on the host network`);
    }
  }
});

test("AT3 the tailscaled socket and the cert directory are read-only bind mounts that are never created", () => {
  const sock = compose.services.api.volumes.find((v) => v.target === "/var/run/tailscale/tailscaled.sock");
  const certs = compose.services.dashboard.volumes.find((v) => v.target === "/certs");
  for (const m of [sock, certs]) {
    assert.ok(m, "mount present");
    assert.equal(m.type, "bind");
    assert.equal(m.read_only, true);
    assert.equal(m.bind?.create_host_path, false);
  }
});

test("AT3 M1.3-a: secure cookies are on by default; migrate gates the api and the worker", () => {
  assert.equal(compose.services.api.environment.DEVOS_COOKIE_SECURE, "${DEVOS_COOKIE_SECURE:-1}");
  for (const s of ["api", "worker"]) assert.equal(compose.services[s].depends_on.migrate.condition, "service_completed_successfully");
  assert.equal(compose.services.migrate.depends_on.postgres.condition, "service_healthy");
});

test("AT3 no secret value is written in the compose file: every secret is a required or empty ${NAME}", () => {
  const secretish = /(PASSWORD|SECRET|_KEY|TOKEN)$/;
  const envs = Object.values(compose.services).flatMap((s) => Object.entries(s.environment ?? {}));
  for (const [k, v] of envs) {
    if (!secretish.test(k)) continue;
    assert.match(String(v), /^\$\{[A-Z0-9_]+(:\?[^}]*|:-)?\}$/, `${k} comes from the environment by name`);
  }
  assert.match(compose["x-db-env"].POSTGRES_PASSWORD, /^\$\{POSTGRES_PASSWORD:\?[^}]*\}$/);
  assert.doesNotMatch(composeText, /^\s*DATABASE_URL:/m, "DATABASE_URL is built in the container (PR20-r1), never interpolated");
  assert.doesNotMatch(composeText, /sk-[A-Za-z0-9]|ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE KEY/);
});

test("AT3 images: four targets, unprivileged runtime, no secret build argument, secrets kept out of the context", () => {
  for (const t of ["api", "dashboard", "worker", "migrate"]) assert.match(dockerfile, new RegExp(`^FROM runtime AS ${t}$`, "m"));
  assert.match(dockerfile, /^USER node$/m);
  const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]);
  assert.deepEqual(args, ["GIT_SHA"]);
  for (const line of [".env", ".env.*", ".git", "**/node_modules"]) assert.ok(dockerignore.split("\n").includes(line), `.dockerignore has ${line}`);
});

// R1 AT5: the health-sha server check against fake `tailscale` and `curl` on PATH.

const CHECK = `${root}scripts/server/checks/health-sha.sh`;
const SHA = "a".repeat(40);

function runCheck({ code, body = "", tsIp = "100.64.0.7", sha = SHA }) {
  const bin = mkdtempSync(join(tmpdir(), "r1-check-"));
  writeFileSync(join(bin, "tailscale"), `#!/usr/bin/env bash\necho ${tsIp}\n`);
  // Fake curl: prints the body, a newline and the HTTP code (what -w '\n%{http_code}' produces).
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n%s' "$FAKE_BODY" "$FAKE_CODE"\n`);
  for (const f of ["tailscale", "curl"]) chmodSync(join(bin, f), 0o755);
  return spawnSync("bash", [CHECK], {
    env: { PATH: `${bin}:${process.env.PATH}`, DEVOS_DIR: bin, DEVOS_SHA: sha, FAKE_BODY: body, FAKE_CODE: code },
    encoding: "utf8",
  });
}

test("AT5 health-sha: pass when /health reports the deployed SHA", () => {
  const r = runCheck({ code: "200", body: JSON.stringify({ status: "ok", sha: SHA, startedAt: "x" }) });
  assert.equal(r.status, 0, r.stdout);
});

test("AT5 health-sha: skipped (3) while nothing answers, never counted as a pass", () => {
  assert.equal(runCheck({ code: "000" }).status, 3);
});

test("AT5 health-sha: fail on another SHA, a non-200, no tailnet IP or a bad DEVOS_SHA", () => {
  assert.equal(runCheck({ code: "200", body: JSON.stringify({ sha: "b".repeat(40) }) }).status, 1);
  assert.equal(runCheck({ code: "200", body: JSON.stringify({ sha: "unknown" }) }).status, 1);
  assert.equal(runCheck({ code: "503", body: "{}" }).status, 1);
  assert.equal(runCheck({ code: "200", body: JSON.stringify({ sha: SHA }), tsIp: "203.0.113.9" }).status, 1);
  assert.equal(runCheck({ code: "200", body: JSON.stringify({ sha: SHA }), sha: "abc" }).status, 1);
});

// PR20-r1: a password with URL-reserved characters still gives a valid DATABASE_URL.
test("AT3 PR20-r1: with-db-url encodes every reserved character and round-trips the password", () => {
  const password = "p#a/s@s:w%o?r&d= +[x]";
  const url = new URL(databaseUrl({ POSTGRES_PASSWORD: password, POSTGRES_HOST: "postgres" }));
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "postgres");
  assert.equal(url.port, "5432");
  assert.equal(url.pathname, "/devos");
  assert.equal(decodeURIComponent(url.password), password);
  assert.throws(() => databaseUrl({}), /^Error: config-postgres-password-required$/);
  assert.throws(() => databaseUrl({ POSTGRES_PASSWORD: "x", POSTGRES_HOST: "a/b" }), /^Error: config-postgres-host-invalid$/);
});

test("AT3 PR20-r1: with-db-url passes DATABASE_URL to the command, drops the raw password, prints no value", () => {
  const password = "r1#/@:%-" + "z".repeat(12);
  const r = spawnSync(process.execPath, [`${root}deploy/with-db-url.mjs`, process.execPath, "-e",
    "const u=new URL(process.env.DATABASE_URL);process.stdout.write(JSON.stringify({pw:decodeURIComponent(u.password),raw:process.env.POSTGRES_PASSWORD??null}))"],
    { env: { PATH: process.env.PATH, POSTGRES_PASSWORD: password }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.pw, password);
  assert.equal(out.raw, null);
  const bad = spawnSync(process.execPath, [`${root}deploy/with-db-url.mjs`, "true"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /config-postgres-password-required/);
});

test("AT4 PR20-r1: the worker's stop grace period covers the drain budget", () => {
  assert.equal(compose.services.worker.stop_grace_period, "60s");
});

// PR20-r2: an unset optional setting reaches the service as unset, not as an empty string.
test("AT3 PR20-r2: empty DEVOS_* settings are removed before the service starts; set ones are kept", () => {
  const env = childEnv({ PATH: "/bin", POSTGRES_PASSWORD: "x", DEVOS_SMTP_PORT: "", DEVOS_SMTP_SECURITY: "", DEVOS_SMTP_HOST: "smtp.example.com", DEVOS_COOKIE_SECURE: "1", OTHER: "" }, "postgresql://u@h/d");
  assert.equal("DEVOS_SMTP_PORT" in env, false);
  assert.equal("DEVOS_SMTP_SECURITY" in env, false);
  assert.equal(env.DEVOS_SMTP_HOST, "smtp.example.com");
  assert.equal(env.DEVOS_COOKIE_SECURE, "1");
  assert.equal(env.OTHER, "", "only DEVOS_* settings are normalised");
  assert.equal("POSTGRES_PASSWORD" in env, false);
  assert.equal(env.DATABASE_URL, "postgresql://u@h/d");
});

test("AT3 PR20-r2: every optional DEVOS_* setting in compose defaults to empty (= unset), never to a guessed value", () => {
  for (const s of ["api", "worker", "dashboard"]) {
    for (const [k, v] of Object.entries(compose.services[s].environment ?? {})) {
      if (!k.startsWith("DEVOS_") || k === "DEVOS_COOKIE_SECURE" || k === "DEVOS_TAILSCALE_SOCKET") continue;
      assert.match(String(v), /^\$\{[A-Z0-9_]+(:\?[^}]*|:-)\}$/, `${s}.${k}`);
    }
  }
});
