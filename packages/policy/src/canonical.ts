// Adapted from ruflo (https://github.com/ruvnet/ruflo), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64,
// file v3/@claude-flow/security/src/policy/canonical.ts. MIT License, Copyright (c) 2024-2026 ruvnet.
// Full licence text: THIRD_PARTY_NOTICES.md at the repository root.
// DevOS changes (M1.7): keys sort by UTF-16 code unit (locale-independent), Dates serialise as ISO
// strings, hashes are bare 64-hex SHA-256 (the policy_decision.hash CHECK), HMAC is hex.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("policy canonicalisation rejects non-finite numbers");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`policy canonicalisation rejects ${typeof value}`);
  }
  return value;
}

/** Deterministic JSON: sorted keys, no undefined members. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** A plain JSON copy in canonical form (what is stored and later re-hashed). */
export function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

/** SHA-256 of the canonical JSON, as 64 lowercase hex characters. */
export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function hmacHex(hash: string, key: Buffer): string {
  return createHmac("sha256", key).update(hash).digest("hex");
}

export function hmacValid(hash: string, mac: string, key: Buffer): boolean {
  const expected = Buffer.from(hmacHex(hash, key), "utf8");
  const actual = Buffer.from(mac, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
