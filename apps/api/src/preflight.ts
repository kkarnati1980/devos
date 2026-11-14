// ADR-0012 CR-a2 (DEVOS-198, docs/modules/ADR-0012.md "CR-a2 design"): the intake pre-flight on the API side.
// `preflightOpen` gates the build (rule 2); `preflightDecisions` turns KK's decision comment into the project
// decision log rows (rule 3). Both are pure over small ports, so the Prisma binding stays thin and testable.
import type { PreflightItem } from "@devos/analyst";

export type PreflightState = "pending" | "approved" | "rejected";

/** The reads `preflightOpen` needs. Any read that throws makes the result false (fail closed). */
export interface PreflightReader {
  /** `project.preflight_state`, or null when the project does not exist. */
  preflightState(projectId: string): Promise<PreflightState | null>;
  /** The newest requirements doc's pre-flight list, or null (no doc, or a doc from outside the mode). */
  latestPreflight(projectId: string): Promise<PreflightItem[] | null>;
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
    if ((await reader.preflightState(projectId)) !== "approved") return false;
    const items = (await reader.latestPreflight(projectId)) ?? [];
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
