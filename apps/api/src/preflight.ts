// ADR-0012 CR-a2 (DEVOS-198, docs/modules/ADR-0012.md "CR-a2 design"): the intake pre-flight on the API side.
// `preflightOpen` gates the build (rule 2); `preflightDecisions` turns KK's decision comment into the project
// decision log rows (rule 3). Both are pure over small ports, so the Prisma binding stays thin and testable.
import type { PreflightItem } from "@devos/analyst";

export type PreflightState = "pending" | "approved" | "rejected";

/** The read `preflightOpen` needs. A read that throws makes the result false (fail closed). */
export interface PreflightReader {
  /**
   * `project.preflight_state` and the newest requirements doc's pre-flight list (null: no doc, or a doc from outside
   * the mode), read from ONE database snapshot; null when the project does not exist. One read, not two, so a spec
   * version committed between them can never pair an `approved` state with the new, unapproved list (Codex PR122-r2).
   */
  preflightSnapshot(projectId: string): Promise<PreflightSnapshot | null>;
}

export interface PreflightSnapshot {
  state: PreflightState | null;
  items: PreflightItem[] | null;
  /** The newest doc's intake card (its approval id), from the same snapshot; the project page scopes answers to it. */
  approvalId?: string | null;
}

/** The vault read (Vault.hasProject satisfies it). Reads no ciphertext. */
export interface SecretPresence {
  hasProject(projectId: string, name: string): Promise<boolean>;
}

/** The vault name a pre-flight secret item is checked under (M2.4: `<env>/<NAME>`). */
export const preflightSecretName = (name: string): string => `preview/${name}`;

/**
 * True only when the pre-flight is approved and every `secret` item of the newest doc is in the project's vault.
 * A project backfilled `approved` with no pre-flight list is open (nothing already running stops).
 */
export async function preflightOpen(projectId: string, reader: PreflightReader, vault: SecretPresence): Promise<boolean> {
  try {
    const snap = await reader.preflightSnapshot(projectId);
    if (!snap || snap.state !== "approved") return false;
    const items = snap.items ?? [];
    for (const it of items) {
      if (it.kind !== "secret") continue;
      if ((await vault.hasProject(projectId, preflightSecretName(it.text))) !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The secret names still missing from the vault, for the project page's "waiting for secrets" line. */
export async function missingSecrets(projectId: string, items: readonly PreflightItem[], vault: SecretPresence): Promise<string[]> {
  const out: string[] = [];
  for (const it of items) if (it.kind === "secret" && (await vault.hasProject(projectId, preflightSecretName(it.text))) !== true) out.push(it.text);
  return out;
}

// The decision rows from KK's comment are built in @devos/analyst (`preflightDecisions`), next to the list builder.
export { preflightDecisions, type PreflightDecisionRow } from "@devos/analyst";

/** One row of the project decision log as the project page shows it. */
export interface PreflightDecisionView {
  itemId: string;
  answer: string;
  source: string;
  createdAt: string;
}

/** The reads the project page's pre-flight section needs (CR-a3, DEVOS-199). */
export interface PreflightViewReader extends PreflightReader {
  /** The project row by slug, or null. */
  projectBySlug(slug: string): Promise<{ id: string; continuousRun: boolean } | null>;
  /**
   * The decision log rows recorded with one intake card (approval), oldest first, bounded by the store. PF numbers
   * restart with every spec version, so only the newest doc's card's rows answer its items (Codex PR127-r1).
   */
  decisions(projectId: string, approvalId: string): Promise<PreflightDecisionView[]>;
}

export interface PreflightView {
  continuousRun: boolean;
  state: PreflightState | null;
  /** `preflightOpen`: the build may start. */
  open: boolean;
  /** The newest doc's list KK saw (secret items carry names only), or [] outside the mode. */
  items: PreflightItem[];
  /** Secret names not yet in the project vault; every secret name when the vault cannot be read (fail closed). */
  missingSecrets: string[];
  /** True when the vault could not be read: `missingSecrets` then lists every name, unverified. */
  secretsUnverified: boolean;
  decisions: PreflightDecisionView[];
}

/**
 * CR-a3 (DEVOS-199): the read-only pre-flight view for the project page. Reads only: no card, no write, and the
 * vault is asked only whether a name is set (never a value). Null when the slug names no project.
 */
export async function preflightView(slug: string, reader: PreflightViewReader, vault: SecretPresence | null): Promise<PreflightView | null> {
  const project = await reader.projectBySlug(slug);
  if (!project) return null;
  // One snapshot for the state, the list and the newest doc's card (same read as preflightOpen, Codex PR122-r2);
  // answers only from that card, never an earlier version's PF-n (Codex PR127-r1).
  const snap = await reader.preflightSnapshot(project.id);
  const state = snap?.state ?? null;
  const items = snap?.items ?? [];
  const decisions = snap?.approvalId ? await reader.decisions(project.id, snap.approvalId) : [];
  const names = items.filter((i) => i.kind === "secret").map((i) => i.text);
  let missing = names;
  let unverified = names.length > 0;
  if (vault && names.length > 0) {
    try {
      missing = await missingSecrets(project.id, items, vault);
      unverified = false;
    } catch {
      missing = names;
      unverified = true;
    }
  }
  // Pre-review CR-a3 #3: `open` from the values already read, so it always agrees with the state and the secret
  // lines shown (preflightOpen's rule: approved, and every secret verified present). CR-c gates on preflightOpen.
  const open = state === "approved" && !unverified && missing.length === 0;
  return { continuousRun: project.continuousRun, state, open, items, missingSecrets: missing, secretsUnverified: unverified, decisions };
}
