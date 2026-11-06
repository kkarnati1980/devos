// M1.4 encrypted vault (docs/modules/M1.4.md). Secrets are write-only over HTTP: the API stores a
// value once (AES-256-GCM under the server's vault key) and only ever returns its name, its last
// 4 characters and its dates. Plaintext leaves this file only through `reveal`, which no route calls.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The secrets KK enters in the wizard (continuous-build amendment, 6 Nov 2026). Global, not per project. */
export const SECRET_NAMES = [
  "anthropic_api_key",
  "openai_api_key",
  "github_token",
  "linear_api_key",
  "r2_access_key_id",
  "r2_secret_access_key",
  "coolify_api_token",
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
  /** Inserts or replaces the global secret `name`; returns true when it replaced an existing value. */
  upsert(row: Omit<SealedSecret, "createdAt" | "updatedAt">): Promise<{ row: SealedSecret; rotated: boolean }>;
  list(): Promise<SealedSecret[]>;
  get(name: string): Promise<SealedSecret | null>;
}

const TAG_BYTES = 16;
const aad = (name: string, keyVersion: number) => Buffer.from(`devos-vault/v1\nglobal\n${name}\n${keyVersion}`, "utf8");

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
    const { row, rotated } = await this.store.upsert({ name, ciphertext, nonce, keyVersion: this.keyVersion, hint: value.slice(-4) });
    return { meta: toMeta(name, row), rotated };
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

/** In-memory store for tests and local runs without a database. */
export class MemoryVaultStore implements VaultStore {
  readonly rows = new Map<string, SealedSecret>();
  constructor(private readonly now: () => number = Date.now) {}
  async upsert(r: Omit<SealedSecret, "createdAt" | "updatedAt">) {
    const prev = this.rows.get(r.name);
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
  async upsert(r: Omit<SealedSecret, "createdAt" | "updatedAt">) {
    return this.db.$transaction(async (tx: any) => {
      const prev = await tx.vaultSecret.findFirst({ where: { projectId: null, name: r.name }, select: { id: true } });
      const data = { ciphertext: r.ciphertext, nonce: r.nonce, keyVersion: r.keyVersion, hint: r.hint };
      const row = prev
        ? await tx.vaultSecret.update({ where: { id: prev.id }, data })
        : await tx.vaultSecret.create({ data: { name: r.name, projectId: null, ...data } });
      return { row: fromRow(row), rotated: Boolean(prev) };
    }, { timeout: this.timeoutMs, maxWait: this.timeoutMs });
  }
  async list() {
    return (await this.db.vaultSecret.findMany({ where: { projectId: null } })).map(fromRow);
  }
  async get(name: string) {
    const row = await this.db.vaultSecret.findFirst({ where: { projectId: null, name } });
    return row ? fromRow(row) : null;
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
