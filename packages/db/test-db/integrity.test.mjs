// M1.1 AT6: integrity rules enforced by the database, not by application code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, rejects, one, fixture, sha } from "./helpers.mjs";

const CHECK = "23514";
const UNIQUE = "23505";

test("AT6 project slug: unique and well-formed", async () => {
  await withTx(async (c) => {
    await fixture(c, "alpha");
    await rejects(c, "INSERT INTO project (slug, name, updated_at) VALUES ('alpha', 'Dup', now())", [], { code: UNIQUE });
    for (const bad of ["A", "has space", "UPPER", "x".repeat(41), "under_score"])
      await rejects(c, "INSERT INTO project (slug, name, updated_at) VALUES ($1, 'Bad', now())", [bad], { code: CHECK, constraint: "project_slug_format" });
  });
});

test("AT6 commit SHA must be 40 lowercase hex and unique per project", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    for (const bad of ["abc", sha("A"), sha("g"), sha("a") + "0"])
      await rejects(c, "INSERT INTO commit (project_id, sha) VALUES ($1, $2)", [f.project, bad], { code: CHECK, constraint: "commit_sha_format" });
    await rejects(c, "INSERT INTO commit (project_id, sha) VALUES ($1, $2)", [f.project, sha("a")], { code: UNIQUE });
  });
});

test("AT6 requirement key unique per project; module cannot depend on itself", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = "INSERT INTO requirement (project_id, key, title, priority, acceptance, updated_at) VALUES ($1, 'DV-FR-001', 't', 'must', 'a', now())";
    await c.query(ins, [f.project]);
    await rejects(c, ins, [f.project], { code: UNIQUE });
    await rejects(c, "INSERT INTO module_dependency (module_id, depends_on_id) VALUES ($1, $1)", [f.module], { code: CHECK, constraint: "module_dependency_no_self" });
  });
});

test("AT6 cost entries: non-negative, and exactly one of run or verdict", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const run = await one(c, "INSERT INTO run (task_id, project_id, role, model, max_turns, max_seconds, max_cost_usd, updated_at) VALUES ($1, $2, 'builder', 'claude-sonnet-5-5', 12, 300, 0.5, now()) RETURNING id", [f.task, f.project]);
    const v = await one(c, "INSERT INTO review_verdict (commit_id, round, reviewer, verdict, summary, raw) VALUES ($1, 1, 'codex', 'pass', 's', '{}') RETURNING id", [f.commit]);
    const ins = "INSERT INTO cost_entry (project_id, run_id, review_verdict_id, provider, model, role, usd) VALUES ($1, $2, $3, 'anthropic', 'm', 'builder', $4)";
    await c.query(ins, [f.project, run.id, null, "0.013803"]);
    await rejects(c, ins, [f.project, run.id, null, "-0.01"], { code: CHECK, constraint: "cost_entry_usd_nonneg" });
    await rejects(c, ins, [f.project, null, null, "0.01"], { code: CHECK, constraint: "cost_entry_one_source" });
    await rejects(c, ins, [f.project, run.id, v.id, "0.01"], { code: CHECK, constraint: "cost_entry_one_source" });
    const sum = await one(c, "SELECT sum(usd)::text AS s FROM cost_entry WHERE project_id = $1", [f.project]);
    assert.equal(sum.s, "0.013803");
  });
});

test("AT6 app_settings is a single row with sane values and the PRD defaults", async () => {
  await withTx(async (c) => {
    const s = await one(c, "INSERT INTO app_settings (updated_at) VALUES (now()) RETURNING *");
    assert.equal(s.anthropic_cap_usd, "15.000000");
    assert.equal(s.probation_minutes, 15);
    assert.equal(s.archive_days, 30);
    assert.equal(s.timezone, "Asia/Kolkata");
    assert.equal(s.report_time, "08:00");
    await rejects(c, "INSERT INTO app_settings (updated_at) VALUES (now())", [], { code: UNIQUE });
    await rejects(c, "UPDATE app_settings SET singleton = false", [], { code: CHECK, constraint: "app_settings_singleton" });
    await rejects(c, "UPDATE app_settings SET openai_cap_usd = 0", [], { code: CHECK, constraint: "app_settings_values" });
    await rejects(c, "UPDATE app_settings SET default_lanes = 3, max_lanes = 2", [], { code: CHECK, constraint: "app_settings_values" });
    await rejects(c, "UPDATE app_settings SET report_time = '25:00'", [], { code: CHECK, constraint: "app_settings_report_time_format" });
  });
});

test("AT6 approvals: decided needs a time; purge approval needs a signed confirmation", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = "INSERT INTO approval (project_id, gate, action, target, reason, status, decided_at, confirmation_hash, updated_at) VALUES ($1, $2, 'a', 't', 'r', $3, $4, $5, now())";
    await rejects(c, ins, [f.project, "decision", "approved", null, null], { code: CHECK, constraint: "approval_decided_has_time" });
    await c.query(ins, [f.project, "decision", "approved", new Date(), null]);
    await rejects(c, ins, [f.project, "purge", "approved", new Date(), null], { code: CHECK, constraint: "approval_purge_confirmed" });
    await c.query(ins, [f.project, "purge", "approved", new Date(), "sha256:abc"]);
  });
});

test("AT6 at most one approved requirements doc per project", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = "INSERT INTO requirements_doc (project_id, version, repo_path, status, updated_at) VALUES ($1, $2, 'docs/requirements.md', $3, now()) RETURNING id";
    await c.query(ins, [f.project, 1, "approved"]);
    await rejects(c, ins, [f.project, 2, "approved"], { code: CHECK, message: /already has an approved requirements doc/ });
    const d = await one(c, ins, [f.project, 3, "draft"]);
    await rejects(c, "UPDATE requirements_doc SET status = 'approved' WHERE id = $1", [d.id], { code: CHECK });
    await c.query("UPDATE requirements_doc SET status = 'superseded' WHERE project_id = $1 AND version = 1", [f.project]);
    await c.query("UPDATE requirements_doc SET status = 'approved' WHERE id = $1", [d.id]);
  });
});

test("AT6 global vault secret names are unique; per-project names are unique per project", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = "INSERT INTO vault_secret (project_id, name, ciphertext, nonce, key_version, updated_at) VALUES ($1, $2, '\\x01', '\\x02', 1, now())";
    await c.query(ins, [null, "ANTHROPIC_API_KEY"]);
    await rejects(c, ins, [null, "ANTHROPIC_API_KEY"], { code: CHECK, message: /already exists/ });
    await c.query(ins, [f.project, "ANTHROPIC_API_KEY"]);
    await rejects(c, ins, [f.project, "ANTHROPIC_API_KEY"], { code: UNIQUE });
    await rejects(c, "INSERT INTO vault_secret (project_id, name, ciphertext, nonce, key_version, updated_at) VALUES (NULL, 'EMPTY', '\\x', '\\x02', 1, now())", [], { code: CHECK, constraint: "vault_secret_material" });
  });
});

test("AT6 deleting a project with history is refused (RESTRICT)", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    await rejects(c, "DELETE FROM project WHERE id = $1", [f.project], { code: "23503" });
  });
});
