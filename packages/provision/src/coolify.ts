// M2.4-a Coolify client (docs/modules/M2.4.md; endpoints confirmed by the M0.4 spike on Coolify 4.5.3).
// Ownership marker: the project description carries `devos:<project id>`, set in the create call itself.

import { ProviderError, Transport, type TransportOptions } from "./http.js";
import { ownershipMarker, type Found, type StepSpec } from "./runner.js";

interface ProjectBody {
  uuid: string;
  name: string;
  description?: string | null;
}

export type CoolifyOptions = Omit<TransportOptions, "provider" | "authHeader" | "extraHeaders">;

export class CoolifyClient {
  readonly http: Transport;
  constructor(opts: CoolifyOptions) {
    this.http = new Transport({ provider: "coolify", timeoutMs: 30_000, ...opts, authHeader: (t) => ({ authorization: `Bearer ${t}` }) });
  }

  /** Coolify has no lookup by name: list and filter. Names are unique per DevOS project by construction. */
  async findProjectsByName(name: string): Promise<ProjectBody[]> {
    const r = await this.http.get<ProjectBody[]>("/api/v1/projects");
    // Codex PR44-r1: only a 200 with an array proves absence. A 404 or any other shape is an inconclusive lookup,
    // never "no project", or the runner would POST a duplicate (Coolify allows duplicate names).
    if (r.status !== 200 || !Array.isArray(r.body)) {
      throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/projects returned an unexpected response (${r.status})`, r.status);
    }
    return r.body.filter((x) => x && x.name === name && typeof x.uuid === "string");
  }

  async getProject(uuid: string): Promise<ProjectBody | null> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(uuid)) throw new Error("coolify-uuid-invalid");
    return (await this.http.get<ProjectBody>(`/api/v1/projects/${uuid}`)).body;
  }

  /** `POST /api/v1/projects` returns only `{uuid}`; the caller reads the project back for its description. */
  async createProject(name: string, description: string): Promise<{ uuid: string }> {
    const r = await this.http.write<{ uuid: string }>("POST", "/api/v1/projects", { name, description });
    if (!r.body || typeof r.body.uuid !== "string") throw new Error("coolify-create-no-uuid");
    return r.body;
  }
}

const toFound = (projectId: string, p: ProjectBody): Found => ({
  externalId: p.uuid,
  name: p.name,
  owned: (p.description ?? "").includes(ownershipMarker(projectId)),
});

/** The Coolify project step: `devos-<slug>`, description carrying the ownership marker. */
export function coolifyProjectStep(cf: CoolifyClient, p: { id: string; slug: string }): StepSpec {
  const name = `devos-${p.slug}`;
  return {
    key: "coolify/project",
    provider: "coolify",
    kind: "project",
    name,
    action: "provision.coolify.project",
    lookup: async () => {
      const all = await cf.findProjectsByName(name);
      // Prefer one we own; two same-named projects where neither is ours is still a conflict.
      const mine = all.find((x) => toFound(p.id, x).owned);
      const pick = mine ?? all[0];
      return pick ? toFound(p.id, pick) : null;
    },
    create: async () => {
      const { uuid } = await cf.createProject(name, `DevOS project ${p.slug} ${ownershipMarker(p.id)}`);
      const got = await cf.getProject(uuid);
      return toFound(p.id, got ?? { uuid, name, description: null });
    },
  };
}
