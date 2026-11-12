// S4 decision 1 as amended by S4-b decision 1: one /24 per stack from the pool 10.208.0.0/14, index 0–1023.
// The index is the stack's port offset in M2.4's project port range, so it is already unique and stable.
import { IsolationError } from "./errors.js";

export const POOL = "10.208.0.0/14";
export const MAX_INDEX = 1023;
export type StackEnv = "preview" | "live";
// Same pattern as isolation-apply.sh (S4-b decision 4), so a name the hook accepts is one the host accepts.
export const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export interface StackNetwork { name: string; subnet: string; gateway: string; idx: number }

export function checkStack(slug: string, env: string, idx: number): asserts env is StackEnv {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new IsolationError("bad_stack", "slug does not match the project slug pattern");
  if (env !== "preview" && env !== "live") throw new IsolationError("bad_stack", "env must be preview or live");
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_INDEX) throw new IsolationError("bad_stack", `stack index must be an integer 0–${MAX_INDEX}`);
}

/** Stack index i → 10.(208 + i div 256).(i mod 256).0/24, gateway .1, network devos-p-<slug>-<env>. */
export function stackNetwork(slug: string, env: string, idx: number): StackNetwork {
  checkStack(slug, env, idx);
  const net = `10.${208 + Math.floor(idx / 256)}.${idx % 256}`;
  return { name: `devos-p-${slug}-${env}`, subnet: `${net}.0/24`, gateway: `${net}.1`, idx };
}

/** M2.4-c1's port → the stack index (offset from the start of DEVOS_PROJECT_PORTS). */
export function indexFromPort(port: number, rangeStart: number): number {
  if (!Number.isInteger(port) || !Number.isInteger(rangeStart) || port < rangeStart) throw new IsolationError("bad_stack", "port is outside the project port range");
  const idx = port - rangeStart;
  if (idx > MAX_INDEX) throw new IsolationError("bad_stack", `port offset above ${MAX_INDEX}`);
  return idx;
}
