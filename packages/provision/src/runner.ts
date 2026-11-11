// M2.4-a create-or-get step runner (docs/modules/M2.4.md, decisions 2, 4, 5 and 6).
// A step: look up by its deterministic name → adopt it if it carries this project's ownership marker →
// otherwise (after the policy check) journal `pending`, create once, record. A create that fails in a way
// that leaves its outcome unknown (timeout, network, 5xx) is followed by a second lookup, never a second create.

import { ProviderError } from "./http.js";

export type ProviderName = "github" | "coolify" | "vault" | "backup_schedule" | "r2" | "cloudflare";

/** What a provider lookup or create returns. `owned` = it carries this project's ownership marker. */
export interface Found {
  externalId: string;
  name: string;
  owned: boolean;
}

export interface StepSpec {
  /** Stable per project, e.g. `github/repo`. */
  key: string;
  provider: ProviderName;
  kind: string;
  /** The deterministic name (the create-or-get key at the provider). */
  name: string;
  /** Policy action, e.g. `provision.github.repo`. */
  action: string;
  lookup(): Promise<Found | null>;
  create(): Promise<Found>;
}

export type StepStatus = "pending" | "done" | "failed";

export interface StepRecord {
  projectId: string;
  key: string;
  status: StepStatus;
  attempts: number;
  externalId: string | null;
  lastError: string | null;
}

export interface ResourceRecord {
  provider: ProviderName;
  kind: string;
  externalId: string;
  name: string;
}

export interface ProvisionStore {
  /** Runs `fn` while holding the project's provisioning lock; a second caller waits. */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T>;
  getStep(projectId: string, key: string): Promise<StepRecord | null>;
  /** Creates or moves the step to `pending` and increments `attempts`. */
  markPending(projectId: string, spec: Pick<StepSpec, "key" | "provider" | "kind">): Promise<void>;
  markDone(projectId: string, spec: Pick<StepSpec, "key" | "provider" | "kind">, externalId: string): Promise<void>;
  markFailed(projectId: string, spec: Pick<StepSpec, "key" | "provider" | "kind">, error: string): Promise<void>;
  /** Upsert into the inventory by (provider, kind, external id). Throws `resource_owned_elsewhere` if the row belongs to another project. */
  recordResource(projectId: string, r: ResourceRecord): Promise<void>;
}

export type PolicyDecision = "allow" | "deny" | "require_approval";
export type Authorize = (action: string, resource: string) => Promise<PolicyDecision>;

export type StepErrorCode =
  | "name_conflict"
  | "policy_denied"
  | "approval_required"
  | "create_unconfirmed"
  | "provider_error"
  | "resource_owned_elsewhere";

export class StepError extends Error {
  constructor(
    public readonly step: string,
    public readonly code: StepErrorCode,
    public readonly retryable: boolean,
    /** ADR-0009: policy and budget stops never count as attempts. */
    public readonly countsAsAttempt: boolean,
    message: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}

export type Outcome = "recorded" | "adopted" | "created";

export interface StepResult {
  key: string;
  externalId: string;
  outcome: Outcome;
}

export interface RunOptions {
  store: ProvisionStore;
  authorize?: Authorize;
}

/** Ownership marker written into each resource this project creates (decision 3). */
export const ownershipMarker = (projectId: string): string => `devos:${projectId}`;

const short = (s: string): string => (s.length > 280 ? `${s.slice(0, 277)}...` : s);

/** A stored error line: the code plus a provider message that never carries a token (http.ts). */
const errLine = (code: string, e?: unknown): string =>
  short(e instanceof ProviderError ? `${code}: ${e.message}` : e instanceof Error && e.name === "StepError" ? `${code}: ${e.message}` : code);

export async function runStep(projectId: string, spec: StepSpec, opts: RunOptions): Promise<StepResult> {
  const { store } = opts;
  const prev = await store.getStep(projectId, spec.key);
  if (prev?.status === "done" && prev.externalId) {
    return { key: spec.key, externalId: prev.externalId, outcome: "recorded" };
  }

  const adopt = async (f: Found): Promise<StepResult> => {
    if (!f.owned) {
      const err = new StepError(spec.key, "name_conflict", false, true,
        `${spec.provider} ${spec.kind} "${spec.name}" exists but was not created for this project`);
      await store.markFailed(projectId, spec, errLine("name_conflict", err));
      throw err;
    }
    await record(f);
    return { key: spec.key, externalId: f.externalId, outcome: "adopted" };
  };

  const record = async (f: Found): Promise<void> => {
    try {
      await store.recordResource(projectId, { provider: spec.provider, kind: spec.kind, externalId: f.externalId, name: f.name });
    } catch (e) {
      if (e instanceof Error && e.message === "resource_owned_elsewhere") {
        const err = new StepError(spec.key, "resource_owned_elsewhere", false, true,
          `${spec.provider} ${spec.kind} ${f.externalId} is in another project's inventory`);
        await store.markFailed(projectId, spec, errLine("resource_owned_elsewhere", err));
        throw err;
      }
      throw e;
    }
    await store.markDone(projectId, spec, f.externalId);
  };

  const lookup = async (): Promise<Found | null> => {
    try {
      return await spec.lookup();
    } catch (e) {
      const transient = e instanceof ProviderError && e.transient;
      await store.markFailed(projectId, spec, errLine("provider_error", e));
      throw new StepError(spec.key, "provider_error", transient, true, `lookup failed for ${spec.provider} ${spec.kind}`);
    }
  };

  const found = await lookup();
  if (found) return adopt(found);

  if (opts.authorize) {
    const decision = await opts.authorize(spec.action, `project:${projectId}`);
    if (decision !== "allow") {
      const code = decision === "deny" ? "policy_denied" : "approval_required";
      await store.markFailed(projectId, spec, code);
      throw new StepError(spec.key, code, false, false, `${spec.action} is ${decision === "deny" ? "denied by policy" : "waiting for approval"}`);
    }
  }

  await store.markPending(projectId, spec);
  let created: Found;
  try {
    created = await spec.create();
  } catch (e) {
    const unknownOutcome = e instanceof ProviderError && (e.transient || (e.code === "http" && (e.status === 409 || e.status === 422)));
    if (!unknownOutcome) {
      await store.markFailed(projectId, spec, errLine("provider_error", e));
      throw new StepError(spec.key, "provider_error", false, true, `create failed for ${spec.provider} ${spec.kind}`);
    }
    // The create may have happened (or the name was taken meanwhile): look again, never create again here.
    const again = await lookup();
    if (again) return adopt(again);
    await store.markFailed(projectId, spec, errLine("create_unconfirmed", e));
    throw new StepError(spec.key, "create_unconfirmed", true, true, `create of ${spec.provider} ${spec.kind} not confirmed; the next run looks it up first`);
  }
  if (!created.owned) {
    // A create must return a resource carrying our marker; anything else is a provider/client bug.
    await store.markFailed(projectId, spec, "provider_error: created resource lacks the ownership marker");
    throw new StepError(spec.key, "provider_error", false, true, `created ${spec.provider} ${spec.kind} lacks the ownership marker`);
  }
  await record(created);
  return { key: spec.key, externalId: created.externalId, outcome: "created" };
}

/** Runs the steps in order under the project's lock; stops at the first failure (the error names the step). */
export async function runProvision(projectId: string, steps: StepSpec[], opts: RunOptions): Promise<StepResult[]> {
  const keys = new Set<string>();
  for (const s of steps) {
    if (keys.has(s.key)) throw new Error(`duplicate step key: ${s.key}`);
    keys.add(s.key);
  }
  return opts.store.withProjectLock(projectId, async () => {
    const out: StepResult[] = [];
    for (const s of steps) out.push(await runStep(projectId, s, opts));
    return out;
  });
}
