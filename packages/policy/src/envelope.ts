// Adapted from ruflo (https://github.com/ruvnet/ruflo), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64,
// file v3/@claude-flow/security/src/policy/envelope.ts. MIT License, Copyright (c) 2024-2026 ruvnet.
// Full licence text: THIRD_PARTY_NOTICES.md at the repository root.
// DevOS changes (M1.7): the dimensions are those of the capability_envelope table (tools, read/write
// paths, network + allow-list, cost, tokens, concurrency, expiry, depth); paths nest on `/` boundaries
// like devos_paths_within(); every dimension is mandatory, so an envelope never means "unlimited".
import type { CapabilityEnvelope, PolicyAction } from "./types.js";

/** Default ceiling on delegation depth (root = 0). */
export const MAX_ENVELOPE_DEPTH = 3;

export interface EnvelopeCheck {
  allowed: boolean;
  reason?: string;
}

/** Repo-relative, no `..`/`.` segments, no control characters, no leading `/`. */
export function isCanonicalPath(path: string): boolean {
  if (!path || path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((seg, i, all) => seg !== ".." && seg !== "." && (seg !== "" || i === all.length - 1));
}

/** True when `child` equals `parent` or lies beneath it (on a `/` boundary). */
export function pathWithin(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, "");
  return child === parent || child === base || child.startsWith(`${base}/`);
}

function pathsWithin(children: readonly string[], parents: readonly string[]): boolean {
  return children.every((c) => isCanonicalPath(c) && parents.some((p) => pathWithin(c, p)));
}

function hostsOf(list: string | null): string[] | null {
  if (list === null) return null;
  return list.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Is this action inside the envelope? Envelope violations are always enforced (ADR-0006 guard). */
export function checkEnvelope(action: PolicyAction, envelope: CapabilityEnvelope, now: number): EnvelopeCheck {
  if (!(envelope.expiresAt > now)) return { allowed: false, reason: "envelope-expired" };
  const checks: Array<[boolean, string]> = [];
  if (action.tool !== undefined) checks.push([envelope.tools.includes(action.tool), "tool-outside-envelope"]);
  if (action.readPaths?.length) {
    checks.push([pathsWithin(action.readPaths, [...envelope.readPaths, ...envelope.writePaths]), "read-path-outside-envelope"]);
  }
  if (action.writePaths?.length) {
    checks.push([pathsWithin(action.writePaths, envelope.writePaths), "write-path-outside-envelope"]);
  }
  if (action.network === true || action.host !== undefined) {
    const hosts = hostsOf(envelope.networkAllowList);
    const hostOk = hosts === null || (action.host !== undefined && hosts.includes(action.host.toLowerCase()));
    checks.push([envelope.network && hostOk, "network-outside-envelope"]);
  }
  if (action.costUsd !== undefined) checks.push([action.costUsd <= envelope.maxCostUsd, "cost-outside-envelope"]);
  if (action.tokens !== undefined) checks.push([action.tokens <= envelope.maxTokens, "tokens-outside-envelope"]);
  if (action.concurrency !== undefined) {
    checks.push([action.concurrency <= envelope.maxConcurrency, "concurrency-outside-envelope"]);
  }
  const failed = checks.find(([ok]) => !ok);
  return failed ? { allowed: false, reason: failed[1] } : { allowed: true };
}

/**
 * The dimensions in which `child` is wider than `parent`. Empty means a valid reduction.
 * Depth must be exactly parent + 1 and at most `maxDepth`.
 */
export function envelopeWidening(
  parent: CapabilityEnvelope,
  child: CapabilityEnvelope,
  maxDepth = MAX_ENVELOPE_DEPTH,
): string[] {
  const widened: string[] = [];
  if (!child.tools.every((t) => parent.tools.includes(t))) widened.push("tools");
  if (!pathsWithin(child.readPaths, parent.readPaths)) widened.push("readPaths");
  if (!pathsWithin(child.writePaths, parent.writePaths)) widened.push("writePaths");
  if (child.network) {
    const p = hostsOf(parent.networkAllowList);
    const c = hostsOf(child.networkAllowList);
    const hostsOk = p === null || (c !== null && c.every((h) => p.includes(h)));
    if (!parent.network || !hostsOk) widened.push("network");
  }
  if (!(child.maxCostUsd <= parent.maxCostUsd)) widened.push("maxCostUsd");
  if (!(child.maxTokens <= parent.maxTokens)) widened.push("maxTokens");
  if (!(child.maxConcurrency <= parent.maxConcurrency)) widened.push("maxConcurrency");
  if (!(child.expiresAt <= parent.expiresAt)) widened.push("expiresAt");
  if (child.depth !== parent.depth + 1 || child.depth > maxDepth) widened.push("depth");
  return widened;
}

/** Derive a child envelope; throws `envelope-cannot-widen:<dims>` if any dimension grows. */
export function delegateEnvelope(
  parent: CapabilityEnvelope,
  child: Omit<CapabilityEnvelope, "depth">,
  maxDepth = MAX_ENVELOPE_DEPTH,
): CapabilityEnvelope {
  const next: CapabilityEnvelope = { ...child, depth: parent.depth + 1 };
  const widened = envelopeWidening(parent, next, maxDepth);
  if (widened.length) throw new Error(`envelope-cannot-widen:${widened.join(",")}`);
  return next;
}
