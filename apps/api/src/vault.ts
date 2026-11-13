// M1.4 encrypted vault (docs/modules/M1.4.md). Secrets are write-only over HTTP: the API stores a
// value once (AES-256-GCM under the server's vault key) and only ever returns its name, its last
// 4 characters and its dates. Plaintext leaves this file only through `reveal`, which no route calls.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeAudit, type AuditEntry } from "./settings.js";

/** The secrets KK enters in the wizard (continuous-build amendment, 6 Nov 2026). Global, not per project. */
export const SECRET_NAMES = [
  "anthropic_api_key",
  "openai_api_key",
  "github_token",
  "linear_api_key",
  "r2_access_key_id",
  "r2_secret_access_key",
  "coolify_api_token",
  // M1.6 (docs/modules/M1.6.md): the MyBrain bell HMAC key (shared with MyBrain) and the SMTP password.
  "mybrain_bell_key",
  "smtp_password",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const isSecretName = (v: string): v is SecretName => (SECRET_NAMES as readonly string[]).includes(v);

export const SECRET_MIN = 16;
export const SECRET_MAX = 4096;
/** Printable ASCII without spaces: API keys and tokens never contain whitespace or control characters. */
const SECRET_CHARS = /^[\x21-\x7e]+$/;

/** Validates a secret value. Returns a code, never the value. */
export function checkSecretValue(v: unknown): string | null {
  if (typeof v !== "string") return "invalid:value";
  if (v.length < SECRET_MIN) return "invalid:value-too-short";
  if (v.length > SECRET_MAX) return "invalid:value-too-long";
  if (!SECRET_CHARS.test(v)) return "invalid:value-characters";
  return null;
}

/** What the API may show about a secret. */
export interface SecretMeta {
  name: SecretName;
  set: boolean;
  hint: string | null;
  keyVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A stored row (`vault_secret`, global: `project_id` NULL). */
export interface SealedSecret {
  name: string;
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
  hint: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultStore {
  /**
   * Inserts or replaces the global secret `name` and, in the same transaction, writes the audit
   * event `audit(rotated)` returns (PR17-r1): a failed audit rolls the secret back.
   */
  upsert(
    row: Omit<SealedSecret, "createdAt" | "updatedAt">,
    audit: (rotated: boolean) => AuditEntry,
  ): Promise<{ row: SealedSecret; rotated: boolean }>;
  list(): Promise<SealedSecret[]>;
  get(name: string): Promise<SealedSecret | null>;
  /**
   * M2.4-c2b: inserts or replaces the project-scoped secret (`project_id` = `projectId`) and writes its audit event in
   * the same transaction. Never touches a global row.
   */
  upsertProject(
    projectId: string,
    row: Omit<SealedSecret, "createdAt" | "updatedAt">,
    audit: (rotated: boolean) => AuditEntry,
  ): Promise<{ rotated: boolean }>;
  /** M2.4-c2b: true when the project holds a secret of that name. Reads no ciphertext. */
  hasProject(projectId: string, name: string): Promise<boolean>;
  /** M2.4-c2b: the sealed project row, for `matchesProject` only. */
  getProject(projectId: string, name: string): Promise<SealedSecret | null>;
}

const TAG_BYTES = 16;
const aad = (name: string, keyVersion: number) => Buffer.from(`devos-vault/v1\nglobal\n${name}\n${keyVersion}`, "utf8");
/** M2.4-c2b: a project row's AAD binds the ciphertext to its project, so a row moved to another project fails to open. */
const projectAad = (projectId: string, name: string, keyVersion: number) =>
  Buffer.from(`devos-vault/v1\nproject:${projectId}\n${name}\n${keyVersion}`, "utf8");

const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Project secret names: `<env>/<NAME>` (M2.4 row 5, e.g. `preview/SESSION_SECRET`). */
export const PROJECT_SECRET_NAME = /^(preview|production)\/[A-Z][A-Z0-9_]{0,63}$/;

export class VaultKeyError extends Error {}

/** Parses `DEVOS_VAULT_KEY` (base64 of exactly 32 random bytes). Never includes the value in an error. */
export function parseVaultKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new VaultKeyError("config-vault-key-invalid");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new VaultKeyError("config-vault-key-invalid");
  return key;
}

export function parseVaultKeyVersion(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new VaultKeyError("config-vault-key-version-invalid");
  return Number(raw);
}

export class Vault {
  constructor(
    private readonly store: VaultStore,
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {
    if (key.length !== 32) throw new VaultKeyError("config-vault-key-invalid");
  }

  /** Encrypts and stores a value (first save or rotation). Returns metadata only. */
  async put(name: SecretName, value: string): Promise<{ meta: SecretMeta; rotated: boolean }> {
    const problem = checkSecretValue(value);
    if (problem) throw new VaultKeyError(problem);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aad(name, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const { row, rotated } = await this.store.upsert({ name, ciphertext, nonce, keyVersion: this.keyVersion, hint: value.slice(-4) }, (rotated) => ({
      action: rotated ? "vault.secret.rotated" : "vault.secret.saved",
      summary: `Secret ${name} ${rotated ? "rotated" : "saved"}`,
      details: { name, keyVersion: this.keyVersion },
    }));
    return { meta: toMeta(name, row), rotated };
  }

  /**
   * M2.4-c2b: seals a generated app secret under its project (`vault_secret.project_id`). Returns nothing about the
   * value; the audit event `vault.app_secret.saved|rotated` carries the project and the name only.
   */
  async putProject(projectId: string, name: string, value: string): Promise<{ rotated: boolean }> {
    if (!PROJECT_ID_RE.test(projectId)) throw new VaultKeyError("invalid:project");
    if (!PROJECT_SECRET_NAME.test(name)) throw new VaultKeyError("invalid:name");
    const problem = checkSecretValue(value);
    if (problem) throw new VaultKeyError(problem);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(projectAad(projectId, name, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    // No hint for app secrets: nothing about the value is shown anywhere (decision 7).
    return this.store.upsertProject(projectId, { name, ciphertext, nonce, keyVersion: this.keyVersion, hint: null }, (rotated) => ({
      action: rotated ? "vault.app_secret.rotated" : "vault.app_secret.saved",
      summary: `App secret ${name} ${rotated ? "rotated" : "saved"}`,
      details: { name, keyVersion: this.keyVersion },
      projectId,
    }));
  }

  async hasProject(projectId: string, name: string): Promise<boolean> {
    if (!PROJECT_ID_RE.test(projectId)) throw new VaultKeyError("invalid:project");
    if (!PROJECT_SECRET_NAME.test(name)) throw new VaultKeyError("invalid:name");
    return this.store.hasProject(projectId, name);
  }

  /**
   * M2.4-c2b (pre-review finding 1): true when the project's sealed copy equals `candidate`. The plaintext never leaves
   * this method; the comparison is constant-time over SHA-256 digests. A missing, foreign-key or tampered row is false.
   */
  async matchesProject(projectId: string, name: string, candidate: string): Promise<boolean> {
    if (!PROJECT_ID_RE.test(projectId)) throw new VaultKeyError("invalid:project");
    if (!PROJECT_SECRET_NAME.test(name)) throw new VaultKeyError("invalid:name");
    if (typeof candidate !== "string") return false;
    const row = await this.store.getProject(projectId, name);
    if (!row || row.keyVersion !== this.keyVersion || row.ciphertext.length <= TAG_BYTES) return false;
    let plain: Buffer;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, row.nonce);
      d.setAAD(projectAad(projectId, name, row.keyVersion));
      d.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - TAG_BYTES));
      plain = Buffer.concat([d.update(row.ciphertext.subarray(0, row.ciphertext.length - TAG_BYTES)), d.final()]);
    } catch {
      return false;
    }
    const digest = (b: Buffer) => createHash("sha256").update(b).digest();
    return timingSafeEqual(digest(plain), digest(Buffer.from(candidate, "utf8")));
  }

  /** The provisioner's `ProjectSecrets` port (@devos/provision, M2.4-c2b). */
  projectSecrets(): {
    has(projectId: string, name: string): Promise<boolean>;
    put(projectId: string, name: string, value: string): Promise<void>;
    matches(projectId: string, name: string, candidate: string): Promise<boolean>;
  } {
    return {
      has: (projectId, name) => this.hasProject(projectId, name),
      matches: (projectId, name, candidate) => this.matchesProject(projectId, name, candidate),
      put: async (projectId, name, value) => {
        await this.putProject(projectId, name, value);
      },
    };
  }

  /** Metadata for every wizard secret, set or not. */
  async list(): Promise<SecretMeta[]> {
    const rows = new Map((await this.store.list()).map((r) => [r.name, r]));
    return SECRET_NAMES.map((n) => toMeta(n, rows.get(n) ?? null));
  }

  /**
   * Server-side consumers only (runtimes, provisioner, server agent): never exposed by a route.
   * A row sealed under another key version, or tampered with, is refused.
   */
  async reveal(name: SecretName): Promise<string | null> {
    const row = await this.store.get(name);
    if (!row) return null;
    if (row.keyVersion !== this.keyVersion) throw new VaultKeyError("vault-key-version-mismatch");
    if (row.ciphertext.length <= TAG_BYTES) throw new VaultKeyError("vault-secret-corrupt");
    const body = row.ciphertext.subarray(0, row.ciphertext.length - TAG_BYTES);
    const tag = row.ciphertext.subarray(row.ciphertext.length - TAG_BYTES);
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, row.nonce);
      d.setAAD(aad(name, row.keyVersion));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString("utf8");
    } catch {
      throw new VaultKeyError("vault-secret-corrupt");
    }
  }
}

function toMeta(name: SecretName, row: SealedSecret | null): SecretMeta {
  if (!row) return { name, set: false, hint: null, keyVersion: null, createdAt: null, updatedAt: null };
  return {
    name,
    set: true,
    hint: row.hint,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** In-memory store for tests and local runs without a database. `failAudit` simulates an audit failure. */
export class MemoryVaultStore implements VaultStore {
  readonly rows = new Map<string, SealedSecret>();
  readonly audits: AuditEntry[] = [];
  failAudit = false;
  constructor(private readonly now: () => number = Date.now) {}
  async upsert(r: Omit<SealedSecret, "createdAt" | "updatedAt">, audit: (rotated: boolean) => AuditEntry) {
    const prev = this.rows.get(r.name);
    if (this.failAudit) throw new Error("audit insert failed");
    this.audits.push(audit(prev !== undefined));
    const t = new Date(this.now());
    const row: SealedSecret = { ...r, createdAt: prev?.createdAt ?? t, updatedAt: t };
    this.rows.set(r.name, row);
    return { row, rotated: prev !== undefined };
  }
  async list() {
    return [...this.rows.values()];
  }
  async get(name: string) {
    return this.rows.get(name) ?? null;
  }
  /** M2.4-c2b: project rows, keyed `<projectId>\n<name>`; kept apart from the global rows. */
  readonly projectRows = new Map<string, SealedSecret>();
  async upsertProject(projectId: string, r: Omit<SealedSecret, "createdAt" | "updatedAt">, audit: (rotated: boolean) => AuditEntry) {
    const k = `${projectId}\n${r.name}`;
    const prev = this.projectRows.get(k);
    if (this.failAudit) throw new Error("audit insert failed");
    this.audits.push(audit(prev !== undefined));
    const t = new Date(this.now());
    this.projectRows.set(k, { ...r, createdAt: prev?.createdAt ?? t, updatedAt: t });
    return { rotated: prev !== undefined };
  }
  async hasProject(projectId: string, name: string) {
    return this.projectRows.has(`${projectId}\n${name}`);
  }
  async getProject(projectId: string, name: string) {
    return this.projectRows.get(`${projectId}\n${name}`) ?? null;
  }
}

/**
 * Prisma-backed store (M1.1 `vault_secret`, global rows have `project_id` NULL). Prisma's compound
 * unique cannot match NULL, so the upsert is find-then-update/create inside one transaction; the
 * M1.1 trigger `vault_secret_global_unique` serialises concurrent creators of the same name.
 */
export class PrismaVaultStore implements VaultStore {
  constructor(
    private readonly db: any,
    private readonly timeoutMs: number,
  ) {}
  private tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }
  async upsert(r: Omit<SealedSecret, "createdAt" | "updatedAt">, audit: (rotated: boolean) => AuditEntry) {
    return this.tx(async (tx: any) => {
      const prev = await tx.vaultSecret.findFirst({ where: { projectId: null, name: r.name }, select: { id: true } });
      const data = { ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.keyVersion, hint: r.hint };
      const row = prev
        ? await tx.vaultSecret.update({ where: { id: prev.id }, data })
        : await tx.vaultSecret.create({ data: { name: r.name, projectId: null, ...data } });
      await writeAudit(tx, audit(Boolean(prev)));
      return { row: fromRow(row), rotated: Boolean(prev) };
    });
  }
  /** M2.4-c2b: the compound unique (`project_id`, `name`) matches a non-null project, so a plain upsert is exact. */
  async upsertProject(projectId: string, r: Omit<SealedSecret, "createdAt" | "updatedAt">, audit: (rotated: boolean) => AuditEntry) {
    return this.tx(async (tx: any) => {
      const where = { projectId_name: { projectId, name: r.name } };
      const prev = await tx.vaultSecret.findUnique({ where, select: { id: true } });
      const data = { ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.keyVersion, hint: r.hint };
      await tx.vaultSecret.upsert({ where, update: data, create: { projectId, name: r.name, ...data }, select: { id: true } });
      await writeAudit(tx, audit(Boolean(prev)));
      return { rotated: Boolean(prev) };
    });
  }
  async hasProject(projectId: string, name: string) {
    return this.tx(async (tx: any) => (await tx.vaultSecret.count({ where: { projectId, name } })) > 0);
  }
  async getProject(projectId: string, name: string) {
    return this.tx(async (tx: any) => {
      const row = await tx.vaultSecret.findUnique({ where: { projectId_name: { projectId, name } } });
      return row ? fromRow(row) : null;
    });
  }
  /** Reads are bounded too (ADR-0011 §9, PR17-r1). */
  async list() {
    return this.tx(async (tx: any) => (await tx.vaultSecret.findMany({ where: { projectId: null } })).map(fromRow));
  }
  async get(name: string) {
    return this.tx(async (tx: any) => {
      const row = await tx.vaultSecret.findFirst({ where: { projectId: null, name } });
      return row ? fromRow(row) : null;
    });
  }
}

function fromRow(row: any): SealedSecret {
  return {
    name: row.name,
    ciphertext: Buffer.from(row.ciphertext),
    nonce: Buffer.from(row.nonce),
    keyVersion: row.keyVersion,
    hint: row.hint ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
