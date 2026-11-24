// DEVOS-234 (M2.4-d3c part 1, docs/modules/M2.4.md "M2.4-d3c decisions"): the pure pieces the AT13 probe CLI is built
// from: the fingerprint of the provisioning code in the image, and the inventory read for one project.
// WIP: the CLI entry (`provision-probe-cli.ts`), live asserts and purge wiring follow in the same part.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isJournalOnlyKind } from "@devos/provision";
import type { InventoryRow } from "./provision-probe.js";

/** Image paths (relative to the repo root in the image) whose content defines "the provisioning code". */
export const FINGERPRINT_ROOTS = ["packages/provision/dist", "packages/isolation/dist", "apps/api/dist"] as const;
/** In `apps/api/dist` only the provisioning files count (`provision-*.js`), so an unrelated API change starts no cycle. */
const API_FILE_RE = /^provision-[a-z0-9-]+\.js$/;

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (ent.isFile() && ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * sha256 over every counted file's repo-relative path and content, in path order, with a length prefix on each part
 * so no two different file sets can hash the same. Missing roots count as empty; no file at all is an error (a
 * fingerprint of nothing would let any image look unchanged).
 */
export async function probeFingerprint(root: string): Promise<string> {
  const files: string[] = [];
  for (const r of FINGERPRINT_ROOTS) {
    for (const f of await walk(join(root, r))) {
      const rel = relative(root, f).split(sep).join("/");
      // Only files directly in apps/api/dist (`apps/api/dist/<file>`), and only the provisioning ones.
      const parts = rel.split("/");
      if (r === "apps/api/dist" && (parts.length !== 4 || !API_FILE_RE.test(parts[3]!))) continue;
      files.push(rel);
    }
  }
  if (files.length === 0) throw new Error("probe-fingerprint-empty");
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const body = await readFile(join(root, rel));
    h.update(`${Buffer.byteLength(rel)}:${rel}\n${body.length}:`);
    h.update(body);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * The probe's inventory: one row per `done` provision step, keyed by the step key, joined to its active resource row
 * by provider, kind and external id. A done step whose resource row is missing, or a step done without an external id,
 * is kept with an empty name or id (a silent drop could hide a lost row); `inventoryIncomplete` then fails the read
 * and names it (Codex PR164-r2), so the same gap in both reads cannot pass the compare. AT13 part 8: a journal-only
 * step (`isJournalOnlyKind`: the core commit, the deploy Compose commit, an app secret) never has a resource row, so its
 * name is the fixed `JOURNAL_ONLY_NAME`; its external id is still required and still compared between the runs.
 */
/** The name a journal-only step carries in the probe's inventory (it has no resource row to take one from). */
export const JOURNAL_ONLY_NAME = "(journal-only)";

export async function readProbeInventory(db: any, projectId: string, timeoutMs: number): Promise<InventoryRow[]> {
  // Pre-review 3: bounded like PrismaProbeLog (ADR-0011: a timeout on every outbound call), one consistent read.
  const [steps, resources] = await db.$transaction(async (tx: any) => [
    await tx.provisionStep.findMany({ where: { projectId, status: "done" }, orderBy: [{ key: "asc" }], select: { key: true, provider: true, kind: true, externalId: true } }),
    await tx.resource.findMany({ where: { projectId, status: "active" }, select: { provider: true, kind: true, externalId: true, name: true } }),
  ], { timeout: timeoutMs, maxWait: timeoutMs }) as [any[], any[]];
  const byId = new Map<string, string>();
  for (const r of resources) byId.set(`${r.provider}\u0000${r.kind}\u0000${r.externalId}`, r.name == null ? "" : String(r.name));
  return steps.map((s) => ({
    key: String(s.key),
    provider: String(s.provider),
    externalId: s.externalId == null ? "" : String(s.externalId),
    name: s.externalId == null ? "" : isJournalOnlyKind(String(s.provider), String(s.kind)) ? JOURNAL_ONLY_NAME : byId.get(`${s.provider}\u0000${s.kind}\u0000${s.externalId}`) ?? "",
  }));
}

/** DEVOS-21: the vault names of the provider tokens the probe provisions and purges with. */
export const PROBE_TOKEN_NAMES = ["github_token", "coolify_api_token"] as const;

/**
 * DEVOS-21: the newest `updatedAt` among the probe's provider tokens (metadata only: no secret is revealed), or null
 * when none is set.
 */
export async function probeCredentialsUpdatedAt(vault: { list(): Promise<Array<{ name: string; set: boolean; updatedAt: string | null }>> }): Promise<string | null> {
  let newest: string | null = null;
  for (const m of await vault.list()) {
    if (!(PROBE_TOKEN_NAMES as readonly string[]).includes(m.name) || !m.set || !m.updatedAt) continue;
    if (newest === null || Date.parse(m.updatedAt) > Date.parse(newest)) newest = m.updatedAt;
  }
  return newest;
}
