// Adapted from ruflo (https://github.com/ruvnet/ruflo), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64,
// file v3/@claude-flow/security/src/policy/engine.ts (appendReceipt, verifyReceipt, verifyLedger).
// MIT License, Copyright (c) 2024-2026 ruvnet. Full licence text: THIRD_PARTY_NOTICES.md.
// DevOS changes (M1.7): a receipt is one policy_decision row; the hash covers every stored column
// (chain, seq from 1, ts, ids, identity, action, outcomes, rule ids, grant, bundle hash, prev hash);
// the HMAC key is mandatory and lives outside the repo; no pruning or anchors (Postgres keeps the
// whole chain append-only and the database trigger enforces gapless seq + prev_hash).
import { canonicalCopy, hmacHex, hmacValid, sha256Hex } from "./canonical.js";
import type { DecisionRow, LedgerVerification } from "./types.js";

export type UnsignedRow = Omit<DecisionRow, "hash" | "hmac">;

/** The exact object the hash covers. Column order is irrelevant: canonical JSON sorts keys. */
export function receiptBody(row: UnsignedRow): Record<string, unknown> {
  return {
    chain: row.chain,
    seq: row.seq,
    ts: row.ts.toISOString(),
    projectId: row.projectId,
    runId: row.runId,
    identity: row.identity,
    action: row.action,
    outcome: row.outcome,
    enforcedOutcome: row.enforcedOutcome,
    matchedRuleIds: row.matchedRuleIds,
    approvalGrantId: row.approvalGrantId,
    bundleHash: row.bundleHash,
    prevHash: row.prevHash,
  };
}

export function sealRow(row: UnsignedRow, key: Buffer): DecisionRow {
  const normalized: UnsignedRow = { ...row, identity: canonicalCopy(row.identity), action: canonicalCopy(row.action) };
  const hash = sha256Hex(receiptBody(normalized));
  return { ...normalized, hash, hmac: hmacHex(hash, key) };
}

/** Verify a whole chain, oldest first. Any changed byte, gap, reorder or bad MAC fails. */
export function verifyLedger(rows: readonly DecisionRow[], key: Buffer): LedgerVerification {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const expectedSeq = i + 1;
    if (row.seq !== expectedSeq || row.prevHash !== prev) {
      return { valid: false, length: rows.length, error: "receipt-chain-mismatch", at: row.seq };
    }
    let hash: string;
    try {
      hash = sha256Hex(receiptBody(row));
    } catch {
      return { valid: false, length: rows.length, error: "receipt-malformed", at: row.seq };
    }
    if (hash !== row.hash) return { valid: false, length: rows.length, error: "receipt-hash-mismatch", at: row.seq };
    if (!hmacValid(hash, row.hmac, key)) {
      return { valid: false, length: rows.length, error: "receipt-hmac-invalid", at: row.seq };
    }
    prev = row.hash;
  }
  return { valid: true, length: rows.length };
}
