// S4-b decision 4: the state document the host reads. Exactly {"stacks":[{slug, env, idx, egress, tailnet}]},
// built from approved selections only (decision 3). This builder refuses what isolation-apply.sh would refuse,
// so DevOS never serves a document the host throws away. The HTTP route (loopback + token) is S4-a2.
import { IsolationError } from "./errors.js";
import { checkStack, type StackEnv } from "./network.js";

export interface StackState { slug: string; env: StackEnv; idx: number; egress: boolean; tailnet: string[] }
const CIDR4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** An IPv4 CIDR inside 100.64.0.0/10 with prefix ≥ /10. IPv6 is refused until S4-b2 (decision 4). */
export function tailnetCidrOk(c: string): boolean {
  const m = typeof c === "string" ? c.match(CIDR4) : null;
  if (!m) return false;
  const o = m.slice(1, 5).map(Number); const p = Number(m[5]);
  if (o.some((x) => x > 255) || p < 10 || p > 32) return false;
  if (m.slice(1, 5).some((x) => x.length > 1 && x.startsWith("0"))) return false;
  return o[0] === 100 && (o[1]! & 0xc0) === 64;
}

export function stateDocument(rows: readonly StackState[]): { stacks: StackState[] } {
  const seenIdx = new Set<number>(), seenStack = new Set<string>();
  const stacks = rows.map((r) => {
    checkStack(r.slug, r.env, r.idx);
    if (typeof r.egress !== "boolean") throw new IsolationError("bad_stack", "egress must be a boolean");
    if (!Array.isArray(r.tailnet) || r.tailnet.length > 64 || !r.tailnet.every(tailnetCidrOk)) throw new IsolationError("bad_stack", "tailnet must be up to 64 IPv4 CIDRs inside 100.64.0.0/10");
    if (seenIdx.has(r.idx)) throw new IsolationError("bad_stack", `stack index ${r.idx} is used twice`);
    if (seenStack.has(`${r.slug}/${r.env}`)) throw new IsolationError("bad_stack", "a stack appears twice");
    seenIdx.add(r.idx); seenStack.add(`${r.slug}/${r.env}`);
    return { slug: r.slug, env: r.env, idx: r.idx, egress: r.egress, tailnet: [...r.tailnet] };   // exactly these keys
  });
  return { stacks };
}
