// M1.1 DB-free checks on prisma/schema.prisma (runs in the M0.6 `build` CI without Postgres).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));

test("31 models, each mapped to a snake_case table", () => {
  assert.equal(models.length, 31);
  for (const m of models) {
    const map = m.body.match(/@@map\("([a-z_]+)"\)/);
    assert.ok(map, `${m.name} has no @@map`);
  }
});

test("single-column ids are Postgres-generated uuids", () => {
  for (const m of models) {
    const id = m.body.match(/^\s+id\s+(.*)$/m);
    if (!id) continue; // composite-key join tables
    assert.match(id[1], /@id @default\(dbgenerated\("gen_random_uuid\(\)"\)\) @db\.Uuid/, m.name);
  }
});

test("every DateTime is timestamptz; every Decimal is numeric(12,6)", () => {
  for (const line of schema.split("\n")) {
    if (/^\s+\w+\s+DateTime\??\s/.test(line)) assert.match(line, /@db\.Timestamptz\(6\)/, line.trim());
    if (/^\s+\w+\s+Decimal\??\s/.test(line)) assert.match(line, /@db\.Decimal\(12, 6\)/, line.trim());
  }
});

test("every relation with fields is ON DELETE RESTRICT", () => {
  const rels = [...schema.matchAll(/@relation\(([^)]*fields:[^)]*)\)/g)].map((m) => m[1]);
  assert.ok(rels.length >= 40);
  for (const r of rels) assert.match(r, /onDelete: Restrict/, r);
});

test("datasource has no url; generator writes the ESM client to src/generated", () => {
  const ds = schema.match(/datasource db \{([\s\S]*?)\}/)[1];
  assert.doesNotMatch(ds, /url/);
  assert.match(schema, /provider\s+= "prisma-client"/);
  assert.match(schema, /output\s+= "\.\.\/src\/generated\/prisma"/);
});

test("vault_secret stores ciphertext only", () => {
  const v = models.find((m) => m.name === "VaultSecret").body;
  assert.match(v, /ciphertext\s+Bytes/);
  assert.match(v, /nonce\s+Bytes/);
  assert.doesNotMatch(v, /\b(value|plaintext|secret)\s+String/i);
});

test("migrations carry no connection string or credential", () => {
  const dir = new URL("../prisma/migrations/", import.meta.url);
  for (const d of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const sql = readFileSync(new URL(`${d.name}/migration.sql`, dir), "utf8");
    assert.doesNotMatch(sql, /postgres(ql)?:\/\/|password\s*=|sk-ant-|sk-[A-Za-z0-9]{20}/i, d.name);
  }
});
