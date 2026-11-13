// M2.4-c2c1 per-project deploy key pair (docs/modules/M2.4.md, "M2.4-c2c split and c2c1 build notes").
// One ed25519 key pair per project: the private half lives only in Coolify (a "private key" Coolify uses to clone
// the project repo), the public half is a read-only GitHub deploy key on `<owner>/devos-<slug>`.
// The private key is generated in memory, sent in exactly one request (the Coolify create) and never stored,
// returned, journalled or logged (F1). The public key is not a secret: it is written into the Coolify key's
// description next to the ownership marker, so a re-run can recreate the GitHub half without reading the private key.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { ProviderError } from "./http.js";
import type { CoolifyClient } from "./coolify.js";
import type { GitHubClient } from "./github.js";
import { ownershipMarker, type Found, type ProvisionStore, type StepSpec } from "./runner.js";
import type { InventoryItem, ResourceOps } from "./teardown-ops.js";

const UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PUB_RE = /\bpub:(ssh-ed25519 [A-Za-z0-9+/]{68})(?=\s|$)/;
/** The step keys, in order. The GitHub half reads the Coolify half's journal row. */
export const COOLIFY_KEY_STEP = "coolify/deploy_key";
export const GITHUB_KEY_STEP = "github/deploy_key";

export const deployKeyName = (slug: string): string => `devos-${slug}-deploy`;

// ---- key generation (OpenSSH encodings) ----

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sshString = (b: Buffer | string): Buffer => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(x.length), x]); };

export interface DeployKeyPair {
  /** `ssh-ed25519 <base64>` (no comment): what GitHub stores and what the description carries. */
  publicKey: string;
  /** OpenSSH private key (unencrypted). Held only until the Coolify create returns. */
  privateKey: string;
}

/** A fresh ed25519 pair. Exported for tests; the step is the only production caller. */
export function generateDeployKeyPair(comment: string): DeployKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.from(String(pubJwk.x), "base64url");
  const seed = Buffer.from(String(privJwk.d), "base64url");
  if (pub.length !== 32 || seed.length !== 32) throw new Error("deploy-key-generation-failed");
  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4).readUInt32BE();
  let priv = Buffer.concat([u32(check), u32(check), sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(pubBlob), sshString(priv)]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  seed.fill(0);
  priv.fill(0);
  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
}

/** `ssh-ed25519 <base64>` from a key line that may carry a comment; null if it is not one. */
export function normalisePublicKey(line: string): string | null {
  const m = /^(ssh-ed25519) ([A-Za-z0-9+/]{68})(?:\s.*)?$/.exec(line.trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

// ---- Coolify private key ----

interface CoolifyKey { uuid: string; name: string; description: string | null }

/**
 * `GET /api/v1/security/keys`. Coolify's entries can carry the private key itself, so each entry is reduced to
 * uuid/name/description right here and nothing else is kept. Only a 200 array of well-formed entries proves absence.
 */
async function listCoolifyKeys(cf: CoolifyClient): Promise<CoolifyKey[]> {
  const r = await cf.http.get<unknown>("/api/v1/security/keys");
  if (r.status !== 200 || !Array.isArray(r.body)) {
    throw new ProviderError("coolify", "bad-response", `coolify GET /api/v1/security/keys returned an unexpected response (${r.status})`, r.status);
  }
  return (r.body as unknown[]).map((x) => {
    const e = x as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.name !== "string" || typeof e.uuid !== "string" || !UUID_RE.test(e.uuid)
      || (e.description !== undefined && e.description !== null && typeof e.description !== "string")) {
      throw new ProviderError("coolify", "bad-response", "coolify GET /api/v1/security/keys returned a malformed key entry", r.status);
    }
    return { uuid: e.uuid, name: e.name, description: (e.description as string | null | undefined) ?? null };
  });
}

const keyOwned = (projectId: string, k: CoolifyKey): boolean => {
  const d = k.description ?? "";
  return d.includes(ownershipMarker(projectId)) && PUB_RE.test(d);
};

/** The public key a Coolify key's description carries, or null. */
export const describedPublicKey = (description: string | null): string | null => PUB_RE.exec(description ?? "")?.[1] ?? null;

function coolifyKeyLookup(cf: CoolifyClient, projectId: string, name: string) {
  return async (): Promise<(Found & { publicKey: string | null }) | null> => {
    const all = (await listCoolifyKeys(cf)).filter((k) => k.name === name);
    const mine = all.filter((k) => keyOwned(projectId, k));
    // Two owned keys with our name: we cannot tell which one GitHub trusts. Inconclusive, never adopted.
    if (mine.length > 1) throw new ProviderError("coolify", "bad-response", "coolify has two owned deploy keys with this project's name", 200);
    const pick = mine[0] ?? all[0];
    if (!pick) return null;
    return { externalId: pick.uuid, name: pick.name, owned: keyOwned(projectId, pick), publicKey: describedPublicKey(pick.description) };
  };
}

/** The Coolify half: `devos-<slug>-deploy`, description = marker + `pub:<public key>`. */
export function coolifyDeployKeyStep(cf: CoolifyClient, p: { id: string; slug: string }): StepSpec {
  const name = deployKeyName(p.slug);
  const lookup = coolifyKeyLookup(cf, p.id, name);
  return {
    key: COOLIFY_KEY_STEP,
    provider: "coolify",
    kind: "private_key",
    name,
    action: "provision.coolify.private_key",
    lookup: async () => {
      const f = await lookup();
      return f && { externalId: f.externalId, name: f.name, owned: f.owned };
    },
    create: async () => {
      let pair: DeployKeyPair | null = generateDeployKeyPair(name);
      const description = `DevOS deploy key ${p.slug} ${ownershipMarker(p.id)} pub:${pair.publicKey}`;
      let uuid: unknown;
      try {
        const r = await cf.http.write<{ uuid?: unknown }>("POST", "/api/v1/security/keys", { name, description, private_key: pair.privateKey });
        uuid = r.body?.uuid;
      } finally {
        pair = null; // drop the only reference to the private key, whatever happened
      }
      // Ownership comes from what Coolify stored: read it back. Not listed yet → transient, so the runner looks up
      // again instead of POSTing a second key.
      const got = await lookup();
      if (!got) throw new ProviderError("coolify", "timeout", "coolify private key not listed yet after create");
      if (typeof uuid === "string" && got.externalId !== uuid) {
        throw new ProviderError("coolify", "bad-response", "coolify listed a different private key than the one created", 200);
      }
      return { externalId: got.externalId, name: got.name, owned: got.owned };
    },
  };
}

// ---- GitHub deploy key ----

interface DeployKeyBody { id: number; title: string; key: string; read_only: boolean }

function repoOf(owner: string, slug: string): [string, string] {
  const repo = `devos-${slug}`;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new Error("github-name-invalid");
  return [owner, repo];
}

const isKeyBody = (x: unknown): x is DeployKeyBody => {
  const e = x as Partial<DeployKeyBody> | null;
  return !!e && typeof e === "object" && Number.isSafeInteger(e.id) && typeof e.title === "string" && typeof e.key === "string" && typeof e.read_only === "boolean";
};

/** `GET /repos/{o}/{r}/keys` (one page of 100; a project repo holds one DevOS key). A full page is inconclusive. */
async function listDeployKeys(gh: GitHubClient, owner: string, repo: string): Promise<DeployKeyBody[]> {
  const r = await gh.http.get<unknown>(`/repos/${owner}/${repo}/keys?per_page=100`);
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.every(isKeyBody) || r.body.length >= 100) {
    throw new ProviderError("github", "bad-response", `github GET /repos/{owner}/{repo}/keys returned an inconclusive response (${r.status})`, r.status);
  }
  return r.body as DeployKeyBody[];
}

/** Owned = our title, our public key, read-only. A same-titled key that differs in either is a conflict. */
const ghKeyFound = (owner: string, repo: string, k: DeployKeyBody, publicKey: string): Found => ({
  externalId: `${owner}/${repo}#${k.id}`,
  name: k.title,
  owned: k.read_only === true && normalisePublicKey(k.key) === publicKey,
});

/** The public key recorded on the Coolify half, read through its journal row (never the private key). */
async function journalledPublicKey(cf: CoolifyClient, store: ProvisionStore, p: { id: string; slug: string }): Promise<string> {
  const row = await store.getStep(p.id, COOLIFY_KEY_STEP);
  if (row?.status !== "done" || !row.externalId) throw new Error("provision-deploy-key-missing: the Coolify key step has not finished");
  const all = await listCoolifyKeys(cf);
  const k = all.find((x) => x.uuid === row.externalId);
  if (!k || !keyOwned(p.id, k)) throw new ProviderError("coolify", "bad-response", "the journalled coolify deploy key is missing or not owned", 200);
  const pub = describedPublicKey(k.description);
  if (!pub) throw new ProviderError("coolify", "bad-response", "the journalled coolify deploy key has no public key", 200);
  return pub;
}

/** The GitHub half: a read-only deploy key `devos-<slug>-deploy` on the project repo, matching the Coolify key. */
export function githubDeployKeyStep(gh: GitHubClient, cf: CoolifyClient, store: ProvisionStore, p: { id: string; slug: string }, owner: string): StepSpec {
  const [o, repo] = repoOf(owner, p.slug);
  const title = deployKeyName(p.slug);
  const lookup = async (): Promise<Found | null> => {
    const pub = await journalledPublicKey(cf, store, p);
    const same = (await listDeployKeys(gh, o, repo)).filter((k) => k.title === title);
    const mine = same.find((k) => ghKeyFound(o, repo, k, pub).owned);
    const pick = mine ?? same[0];
    return pick ? ghKeyFound(o, repo, pick, pub) : null;
  };
  return {
    key: GITHUB_KEY_STEP,
    provider: "github",
    kind: "deploy_key",
    name: `${o}/${repo}#${title}`,
    action: "provision.github.deploy_key",
    lookup,
    create: async () => {
      const pub = await journalledPublicKey(cf, store, p);
      const r = await gh.http.write<unknown>("POST", `/repos/${o}/${repo}/keys`, { title, key: pub, read_only: true });
      if (!isKeyBody(r.body)) throw new ProviderError("github", "bad-response", "github deploy key create returned no key", r.status);
      return ghKeyFound(o, repo, r.body, pub);
    },
  };
}

/** Both halves, Coolify first. Runs after `github/repo` (the repo must exist). */
export function deployKeySteps(gh: GitHubClient, cf: CoolifyClient, store: ProvisionStore, p: { id: string; slug: string }, owner: string): StepSpec[] {
  return [coolifyDeployKeyStep(cf, p), githubDeployKeyStep(gh, cf, store, p, owner)];
}

// ---- teardown ops (for M2.5-a3b) ----

const gone = (e: unknown): boolean => e instanceof ProviderError && e.code === "http" && (e.status === 404 || e.status === 410);

/** Coolify private key: owned = description carries the marker. One DELETE; 404/410 = already gone. */
export function coolifyPrivateKeyOps(cf: CoolifyClient, projectId: string): ResourceOps {
  const check = (item: InventoryItem): string => {
    if (!UUID_RE.test(item.externalId)) throw new Error("coolify-uuid-invalid");
    return item.externalId;
  };
  return {
    provider: "coolify",
    kind: "private_key",
    inspect: async (item) => {
      const uuid = check(item);
      const k = (await listCoolifyKeys(cf)).find((x) => x.uuid === uuid);
      return k ? { owned: (k.description ?? "").includes(ownershipMarker(projectId)) } : null;
    },
    remove: async (item) => {
      const uuid = check(item);
      try { await cf.http.write("DELETE", `/api/v1/security/keys/${uuid}`); } catch (e) { if (!gone(e)) throw e; }
    },
  };
}

function splitKeyId(externalId: string): [string, string, number] {
  const m = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})#([0-9]{1,15})$/.exec(externalId);
  if (!m) throw new Error("github-deploy-key-id-invalid");
  return [m[1]!, m[2]!, Number(m[3])];
}

/**
 * GitHub deploy key: owned = the repo is ours (private, description ends with the marker) and the key is read-only.
 * Deleting the repo deletes its keys too, so a 404 on the key or the repo is "already gone".
 */
export function githubDeployKeyOps(gh: GitHubClient, projectId: string): ResourceOps {
  return {
    provider: "github",
    kind: "deploy_key",
    inspect: async (item) => {
      const [o, repo, id] = splitKeyId(item.externalId);
      const r = await gh.http.get<unknown>(`/repos/${o}/${repo}/keys/${id}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !isKeyBody(r.body)) {
        throw new ProviderError("github", "bad-response", `github GET /repos/{owner}/{repo}/keys/{id} returned an inconclusive response (${r.status})`, r.status);
      }
      const rr = await gh.http.get<{ private?: unknown; description?: unknown }>(`/repos/${o}/${repo}`);
      if (rr.status === 404) return null;
      const d = typeof rr.body?.description === "string" ? rr.body.description : "";
      return { owned: r.body.read_only === true && rr.body?.private === true && d.trim().endsWith(ownershipMarker(projectId)) };
    },
    remove: async (item) => {
      const [o, repo, id] = splitKeyId(item.externalId);
      try { await gh.http.write("DELETE", `/repos/${o}/${repo}/keys/${id}`); } catch (e) { if (!gone(e)) throw e; }
    },
  };
}
