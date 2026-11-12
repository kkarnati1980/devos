// S4 decision 7: the afterStack hook for M2.4's provision.hooks.afterStack(project, env). It hardens the stack's
// Compose before Coolify gets it and records the stack for the state endpoint. It never touches the host: no
// child process, no iptables, no Docker socket (AT9). The store is injected; the Postgres store and the
// GET /internal/isolation-state route are S4-a2.
import { hardenCompose, DEFAULT_LIMITS, type LimitSettings } from "./compose.js";
import { IsolationError } from "./errors.js";
import { indexFromPort, stackNetwork, type StackEnv } from "./network.js";

export interface StackRecord { projectId: string; slug: string; env: StackEnv; idx: number; network: string; subnet: string }
export interface IsolationStore { recordStack(r: StackRecord): Promise<void> }
export interface HookProject { id: string; slug: string }
export interface HookEnv { name: string; port: number; portRangeStart: number; compose: unknown }

export function isolationHook({ settings = DEFAULT_LIMITS, store }: { settings?: LimitSettings; store: IsolationStore }) {
  return async function afterStack(project: HookProject, env: HookEnv): Promise<{ compose: Record<string, unknown>; network: string; subnet: string }> {
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id) throw new IsolationError("bad_stack", "project id missing");
    if (!env || typeof env !== "object") throw new IsolationError("bad_stack", "stack missing");
    const idx = indexFromPort(env.port, env.portRangeStart);
    const net = stackNetwork(project.slug, env.name, idx);
    const compose = hardenCompose(env.compose, env.name as StackEnv, net, settings);   // throws before anything is recorded
    await store.recordStack({ projectId: project.id, slug: project.slug, env: env.name as StackEnv, idx, network: net.name, subnet: net.subnet });
    return { compose, network: net.name, subnet: net.subnet };
  };
}
