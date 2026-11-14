#!/usr/bin/env node
// DEVOS-197: install the gitleaks version CI pins, for `pnpm secret-scan:local`. The version and SHA-256 are read
// from .github/actions/security-tools/action.yml, so the local copy can never drift from CI's. Linux x64 only (the
// runners and the CI image). The checksum is verified before the binary is unpacked; a mismatch installs nothing.
//   node scripts/security/install-gitleaks.mjs   → prints the installed path
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ACTION = fileURLToPath(new URL("../../.github/actions/security-tools/action.yml", import.meta.url));

/** { version, sha256 } exactly as the CI composite action pins them. */
export function pinnedGitleaks(text = readFileSync(ACTION, "utf8")) {
  const version = /GITLEAKS_VERSION:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(text)?.[1];
  const sha256 = /GITLEAKS_SHA256:\s*"([0-9a-f]{64})"/.exec(text)?.[1];
  if (!version || !sha256) throw new Error("security-tools action.yml: GITLEAKS_VERSION / GITLEAKS_SHA256 not found");
  return { version, sha256 };
}

export function cachedGitleaksPath(version, env = process.env) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "devos-tools", `gitleaks-${version}`, "gitleaks");
}

export async function install({ env = process.env, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const { version, sha256 } = pinnedGitleaks();
  const dest = cachedGitleaksPath(version, env);
  if (existsSync(dest)) return dest;
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error(`gitleaks install: only linux x64 is supported (this is ${process.platform} ${process.arch})`);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!res.ok) throw new Error(`gitleaks install: download failed (HTTP ${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`gitleaks install: checksum mismatch (expected ${sha256}, got ${got})`);
  const work = mkdtempSync(join(tmpdir(), "gitleaks-install-"));
  try {
    writeFileSync(join(work, "gitleaks.tgz"), body);
    const tar = spawnSync("tar", ["-xzf", join(work, "gitleaks.tgz"), "-C", work, "gitleaks"], { encoding: "utf8", timeout: 60_000 });
    if (tar.status !== 0) throw new Error(`gitleaks install: unpack failed (${tar.stderr?.trim() || tar.status})`);
    mkdirSync(dirname(dest), { recursive: true });
    // Copy next to the destination, then rename: the temp dir may be on another filesystem, and a half-copied
    // binary must never sit at the cached path.
    const part = `${dest}.${process.pid}.part`;
    copyFileSync(join(work, "gitleaks"), part);
    chmodSync(part, 0o755);
    renameSync(part, dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return dest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  install().then((p) => { console.log(p); }, (e) => { console.error(e.message); process.exit(2); });
}
