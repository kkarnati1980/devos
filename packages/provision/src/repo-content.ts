// M2.4-b (docs/modules/M2.4.md, decision 8): the S3 core as an in-memory file list, ready to push through the
// GitHub Git Data API. Each file carries its git blob SHA-1, so the tree on GitHub can be compared byte for byte.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RepoFileMode = "100644" | "100755";

export interface RepoFile {
  /** POSIX path relative to the repo root. */
  path: string;
  mode: RepoFileMode;
  content: Buffer;
  /** The git blob id: sha1("blob <len>\0" + content). */
  sha: string;
}

/** Limits that keep a template push small and bounded (the core is about 12 files and 80 KB). */
export const REPO_LIMITS = { maxFiles: 500, maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000 } as const;

export const blobSha = (content: Buffer): string =>
  createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** Rejects paths GitHub would refuse or that could escape the repo root (`..`, `.git`, odd characters). */
export function assertRepoPath(p: string): void {
  const parts = p.split("/");
  if (!p || p.length > 400 || parts.some((x) => !SAFE_SEGMENT.test(x) || x === "." || x === ".." || x.toLowerCase() === ".git")) {
    throw new Error(`repo-path-invalid: ${JSON.stringify(p.slice(0, 80))}`);
  }
}

/**
 * Reads every regular file under `dir` (sorted by path). Symlinks, devices and anything but regular files and
 * directories are refused: the template core never has them, and pushing a link target would be a surprise.
 */
export function readRepoFiles(dir: string): RepoFile[] {
  const out: RepoFile[] = [];
  let total = 0;
  const walk = (abs: string, rel: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(a, r); continue; }
      if (!e.isFile()) throw new Error(`repo-file-unsupported: ${r}`);
      assertRepoPath(r);
      const st = fs.statSync(a);
      if (st.size > REPO_LIMITS.maxFileBytes) throw new Error(`repo-file-too-large: ${r}`);
      total += st.size;
      if (total > REPO_LIMITS.maxTotalBytes) throw new Error("repo-too-large");
      if (out.length + 1 > REPO_LIMITS.maxFiles) throw new Error("repo-too-many-files");
      const content = fs.readFileSync(a);
      out.push({ path: r, mode: st.mode & 0o111 ? "100755" : "100644", content, sha: blobSha(content) });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** S3's `apply()` (scripts/template/apply.mjs), injected so this package does not import from `scripts/`. */
export type ApplyTemplate = (o: { out: string; select?: string[]; sha?: string }) => { code: number; error?: string };

export const TEMPLATE_MANIFEST = ".devos/template.json";

/**
 * Generates the S3 core (no selection: add-ons come later from M3.2) into a fresh temp dir, reads it, and removes
 * the dir. Fails unless `.devos/template.json` says nothing was selected or applied (AT6, Phase PS amendment).
 */
export function coreTemplateFiles(apply: ApplyTemplate, opts: { devosSha: string; tmpRoot?: string }): RepoFile[] {
  const root = fs.mkdtempSync(path.join(opts.tmpRoot ?? fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "devos-core-"));
  const out = path.join(root, "repo");
  try {
    const r = apply({ out, select: [], sha: opts.devosSha });
    if (r.code !== 0) throw new Error(`template-apply-failed: ${r.error ?? r.code}`);
    const files = readRepoFiles(out);
    const manifest = files.find((f) => f.path === TEMPLATE_MANIFEST);
    if (!manifest) throw new Error("template-manifest-missing");
    const m = JSON.parse(manifest.content.toString("utf8")) as { selected?: unknown; applied?: unknown };
    if (!Array.isArray(m.selected) || m.selected.length || !Array.isArray(m.applied) || m.applied.length) {
      throw new Error("template-not-core-only");
    }
    return files;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
