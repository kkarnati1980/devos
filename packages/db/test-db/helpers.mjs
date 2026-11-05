// Shared helpers for the Postgres tests (M1.1). Each test runs inside a transaction that is rolled
// back, so tests never leave rows behind and can run in any order.
import pg from "pg";
import assert from "node:assert/strict";

export function url() {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL is required for test:db");
  return u;
}

export async function withTx(fn) {
  const client = new pg.Client({ connectionString: url() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

/** Run `sql` inside a savepoint and assert it fails; optionally match the error code or text. */
export async function rejects(client, sql, params = [], match = {}) {
  await client.query("SAVEPOINT t");
  let err = null;
  try {
    await client.query(sql, params);
  } catch (e) {
    err = e;
  }
  await client.query("ROLLBACK TO SAVEPOINT t");
  assert.ok(err, `expected failure: ${sql}`);
  if (match.code) assert.equal(err.code, match.code, `${sql}: ${err.message}`);
  if (match.constraint) assert.equal(err.constraint, match.constraint, `${sql}: ${err.message}`);
  if (match.message) assert.match(err.message, match.message);
  return err;
}

export async function one(client, sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows[0];
}

export const sha = (c) => c.repeat(40).slice(0, 40);

/** Minimal valid fixture: project, milestone, module, task, commit. */
export async function fixture(client, slug = "fixture-project") {
  const p = await one(client, "INSERT INTO project (slug, name, updated_at) VALUES ($1, 'Fixture', now()) RETURNING id", [slug]);
  const ms = await one(client, "INSERT INTO milestone (project_id, ordinal, name, gate_name, updated_at) VALUES ($1, 1, 'P1', 'G1', now()) RETURNING id", [p.id]);
  const mod = await one(client, "INSERT INTO module (project_id, milestone_id, key, title, lane, contract_path, updated_at) VALUES ($1, $2, 'M1.1', 'Data model', 1, 'docs/modules/M1.1.md', now()) RETURNING id", [p.id, ms.id]);
  const task = await one(client, "INSERT INTO task (project_id, module_id, kind, title, updated_at) VALUES ($1, $2, 'build', 'Build', now()) RETURNING id", [p.id, mod.id]);
  const commit = await one(client, "INSERT INTO commit (project_id, sha) VALUES ($1, $2) RETURNING id", [p.id, sha("a")]);
  return { project: p.id, milestone: ms.id, module: mod.id, task: task.id, commit: commit.id };
}
