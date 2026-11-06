// Adapted from ruflo (https://github.com/ruvnet/ruflo), commit a3d45e64b9ce66d3a172c8051e8b20561321eb64,
// file v3/@claude-flow/security/src/policy/evaluator.ts. MIT License, Copyright (c) 2024-2026 ruvnet.
// Full licence text: THIRD_PARTY_NOTICES.md at the repository root.
// DevOS changes (M1.7): no `legacy` mode (observe | enforce only); gate rules and envelope violations
// are enforced in observe mode; evidence provenance comes from DevOS's typed provenance (ADR-0006 §7).
import { checkEnvelope } from "./envelope.js";
import type { PolicyEffect, PolicyMode, PolicyRequest, PolicyRule } from "./types.js";

export function wildcard(patterns: readonly string[], value: string | undefined): boolean {
  if (!patterns.length) return true;
  if (value === undefined || value === "") return false;
  return patterns.some((p) => p === "*" || p === value || (p.endsWith("*") && value.startsWith(p.slice(0, -1))));
}

function constraintsPass(request: PolicyRequest, rule: PolicyRule): boolean {
  const c = rule.constraints ?? {};
  const { action } = request;
  if (c.maxCostUsd !== undefined && (action.costUsd === undefined || action.costUsd > c.maxCostUsd)) return false;
  if (c.maxTokens !== undefined && (action.tokens === undefined || action.tokens > c.maxTokens)) return false;
  if (c.network === false && action.network === true) return false;
  if (c.requiredProvenance?.length) {
    const have = new Set((request.evidence ?? []).map((e) => e.provenance));
    if (!c.requiredProvenance.every((p) => have.has(p))) return false;
  }
  return true;
}

export function ruleMatches(rule: PolicyRule, request: PolicyRequest): boolean {
  if (!rule.enabled) return false;
  const { identity, action } = request;
  return wildcard(rule.actions, action.type)
    && wildcard(rule.resources, action.resource)
    && wildcard(rule.principals, identity.id)
    && (!rule.roles.length || rule.roles.some((r) => identity.roles?.includes(r)))
    && wildcard(rule.environments, action.environment)
    && constraintsPass(request, rule);
}

export interface RuleEvaluation {
  outcome: PolicyEffect;
  enforcedOutcome: PolicyEffect;
  reason: string;
  matchedRuleIds: string[];
  /** The deciding rule is a gate (always enforced). */
  gate: boolean;
}

/**
 * Envelope first, then rules: deny > require_approval > allow > default deny.
 * In observe mode only gates and envelope violations block; everything else is recorded as would-block.
 */
export function evaluateRules(
  request: PolicyRequest,
  rules: readonly PolicyRule[],
  mode: PolicyMode,
  now: number,
): RuleEvaluation {
  if (request.envelope) {
    const env = checkEnvelope(request.action, request.envelope, now);
    if (!env.allowed) {
      return { outcome: "deny", enforcedOutcome: "deny", reason: env.reason ?? "envelope-denied", matchedRuleIds: [], gate: true };
    }
  }
  const matched = rules
    .filter((r) => ruleMatches(r, request))
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const deny = matched.find((r) => r.effect === "deny");
  const approval = matched.find((r) => r.effect === "require_approval");
  const allow = matched.find((r) => r.effect === "allow");
  const decider = deny ?? approval ?? allow;
  const outcome: PolicyEffect = decider ? decider.effect : "deny";
  const reason = decider
    ? `${outcome === "allow" ? "allowed" : outcome === "deny" ? "denied" : "approval-required"}-by:${decider.id}`
    : "default-deny";
  const gate = decider?.constraints?.gate === true && decider.effect !== "allow";
  const enforcedOutcome: PolicyEffect = mode === "enforce" || gate ? outcome : "allow";
  return { outcome, enforcedOutcome, reason, matchedRuleIds: matched.map((r) => r.id), gate };
}
