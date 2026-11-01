// M1.1 AT4 (coverage), AT5 (conventions), AT10 (no plaintext secrets), asserted from the catalogue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx } from "./helpers.mjs";

const TABLES = [
  "project", "spec", "requirements_doc", "requirement", "milestone", "module", "module_dependency",
  "module_requirement", "task", "task_requirement", "task_blocker", "run", "checkpoint", "cost_entry",
  "commit", "test_evidence", "review_verdict", "review_finding", "deploy", "health_check", "approval",
  "approval_comment", "resource", "app_settings", "role_model", "notification_channel", "vault_secret",
  "memory_item", "audit_event", "notification", "report",
];

// Unique keys the contract names (table -> column lists).
const UNIQUES = {
  project: [["slug"]],
  spec: [["project_id", "version"]],
  requirements_doc: [["project_id", "version"]],
  requirement: [["project_id", "key"]],
  milestone: [["project_id", "ordinal"]],
  module: [["project_id", "key"]],
  checkpoint: [["run_id", "seq"]],
  commit: [["project_id", "sha"]],
  review_verdict: [["commit_id", "round"]],
  resource: [["provider", "kind", "external_id"]],
  role_model: [["role"]],
  notification_channel: [["kind"]],
  vault_secret: [["project_id", "name"]],
  report: [["kind", "period_start"]],
  app_settings: [["singleton"]],
};

const CHECKS = [
  "project_slug_format", "commit_sha_format", "project_lanes_range", "project_cap_positive",
  "module_dependency_no_self", "cost_entry_usd_nonneg", "cost_entry_one_source", "app_settings_singleton",
  "app_settings_values", "approval_decided_has_time", "approval_purge_confirmed", "review_finding_line_nonneg",
];
const TRIGGERS = [
  "requirements_doc_one_approved", "vault_secret_global_unique", "deploy_requires_pass",
  "review_verdict_immutable", "audit_event_no_update", "audit_event_no_truncate",
];

test("AT4 every contract table exists, and no others", async () => {
  await withTx(async (c) => {
    const r = await c.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1");
    assert.deepEqual(r.rows.map((x) => x.table_name).sort(), [...TABLES].sort());
  });
});

test("AT4 unique keys, checks and triggers named in the contract exist", async () => {
  await withTx(async (c) => {
    const u = await c.query(`
      SELECT t.relname AS tbl, array_agg(a.attname::text ORDER BY k.ord) AS cols
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE i.indisunique AND NOT i.indisprimary
      GROUP BY t.relname, i.indexrelid`);
    const have = new Set(u.rows.map((x) => `${x.tbl}:${x.cols.join(",")}`));
    for (const [tbl, sets] of Object.entries(UNIQUES))
      for (const cols of sets) assert.ok(have.has(`${tbl}:${cols.join(",")}`), `missing unique ${tbl}(${cols})`);
    const ck = await c.query("SELECT conname FROM pg_constraint WHERE contype = 'c'");
    const cks = new Set(ck.rows.map((x) => x.conname));
    for (const name of CHECKS) assert.ok(cks.has(name), `missing check ${name}`);
    const tg = await c.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal");
    const tgs = new Set(tg.rows.map((x) => x.tgname));
    for (const name of TRIGGERS) assert.ok(tgs.has(name), `missing trigger ${name}`);
  });
});

test("AT5 primary-key columns are uuid", async () => {
  await withTx(async (c) => {
    const r = await c.query(`
      SELECT t.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND t.relname <> '_prisma_migrations'`);
    assert.ok(r.rows.length >= TABLES.length);
    for (const row of r.rows) assert.equal(row.type, "uuid", `${row.relname}.${row.attname}`);
  });
});

test("AT5 every timestamp is timestamptz; every money column is numeric(12,6)", async () => {
  await withTx(async (c) => {
    const r = await c.query(`
      SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'`);
    for (const col of r.rows) {
      if (col.data_type.startsWith("timestamp"))
        assert.equal(col.data_type, "timestamp with time zone", `${col.table_name}.${col.column_name}`);
      if (/(^|_)usd$/.test(col.column_name)) {
        assert.equal(col.data_type, "numeric", `${col.table_name}.${col.column_name}`);
        assert.deepEqual([col.numeric_precision, col.numeric_scale], [12, 6], `${col.table_name}.${col.column_name}`);
      }
    }
  });
});

test("AT5 every foreign key is ON DELETE RESTRICT and its column leads an index", async () => {
  await withTx(async (c) => {
    const fks = await c.query(`
      SELECT con.conname, con.confdeltype, t.relname AS tbl, con.conkey
      FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      WHERE con.contype = 'f'`);
    assert.ok(fks.rows.length >= 40);
    const idx = await c.query(`
      SELECT t.relname AS tbl, i.indkey[0] AS lead
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'`);
    const leads = new Set(idx.rows.map((x) => `${x.tbl}:${x.lead}`));
    for (const fk of fks.rows) {
      assert.equal(fk.confdeltype, "r", `${fk.conname} is not RESTRICT`);
      assert.equal(fk.conkey.length, 1, `${fk.conname} is multi-column`);
      assert.ok(leads.has(`${fk.tbl}:${fk.conkey[0]}`), `${fk.conname}: column not indexed`);
    }
  });
});

test("AT10 vault_secret has no plaintext column", async () => {
  await withTx(async (c) => {
    const r = await c.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vault_secret'");
    const cols = Object.fromEntries(r.rows.map((x) => [x.column_name, x.data_type]));
    assert.equal(cols.ciphertext, "bytea");
    assert.equal(cols.nonce, "bytea");
    for (const name of Object.keys(cols)) assert.doesNotMatch(name, /plain|value|secret$/);
  });
});
