// M1.1 v1.1: ADR-0006/0008/0009 entities (adoption plan v1.0.0, section 3) and their integrity rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withTx, rejects, one, fixture } from "./helpers.mjs";

const CHECK = "23514";
const UNIQUE = "23505";
const h = (s) => createHash("sha256").update(s).digest("hex");

async function run(c, f) {
  return one(c, "INSERT INTO run (task_id, project_id, role, model, max_turns, max_seconds, max_cost_usd, updated_at) VALUES ($1, $2, 'builder', 'claude-sonnet-5-5', 12, 300, 0.5, now()) RETURNING id", [f.task, f.project]);
}

test("plan AT: a duplicate (run_id, seq) event is rejected by the unique constraint; a gap is rejected", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const r = await run(c, f);
    const ins = "INSERT INTO run_event (run_id, seq, type, payload) VALUES ($1, $2, $3, '{}')";
    await c.query(ins, [r.id, 1, "status"]);
    await c.query(ins, [r.id, 2, "text"]);
    await rejects(c, ins, [r.id, 2, "text"], { code: UNIQUE });
    await rejects(c, ins, [r.id, 4, "done"], { code: CHECK, message: /leaves a gap/ });
    await c.query(ins, [r.id, 3, "done"]);
    await rejects(c, "UPDATE run_event SET payload = '{\"x\":1}' WHERE run_id = $1", [r.id], { code: CHECK, message: /append-only/ });
  });
});

test("plan AT: policy_decision seq is gapless per chain and each receipt links to the previous hash", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = `INSERT INTO policy_decision (chain, seq, project_id, identity, action, outcome, enforced_outcome, matched_rule_ids, bundle_hash, hash, prev_hash, hmac)
                 VALUES ($1, $2, $3, '{"role":"builder"}', '{"tool":"Bash"}', 'deny', 'allow', '{}', 'b1', $4, $5, 'mac')`;
    const h1 = h("r1"), h2 = h("r2"), h3 = h("r3");
    await rejects(c, ins, ["t", 1, f.project, h1, h("bogus")], { code: CHECK, message: /prev_hash/ });
    await c.query(ins, ["t", 1, f.project, h1, null]);
    await rejects(c, ins, ["t", 3, f.project, h3, h1], { code: CHECK, message: /not the next/ });
    await rejects(c, ins, ["t", 2, f.project, h2, h("other")], { code: CHECK, message: /prev_hash/ });
    await c.query(ins, ["t", 2, f.project, h2, h1]);
    await c.query(ins, ["t", 3, f.project, h3, h2]);
    // A separate chain starts again at 1.
    await c.query(ins, ["u", 1, f.project, h("u1"), null]);
    // Receipts are append-only: no update, delete or truncate.
    await rejects(c, "UPDATE policy_decision SET outcome = 'allow' WHERE chain = 't' AND seq = 2", [], { code: CHECK, message: /append-only/ });
    await rejects(c, "DELETE FROM policy_decision WHERE chain = 't' AND seq = 3", [], { code: CHECK, message: /append-only/ });
    await rejects(c, "TRUNCATE policy_decision", [], { code: CHECK, message: /append-only/ });
    const seqs = await c.query("SELECT seq FROM policy_decision WHERE chain = 't' ORDER BY seq");
    assert.deepEqual(seqs.rows.map((r) => r.seq), [1, 2, 3]);
  });
});

test("ADR-0006: policy mode starts observe; only KK may lower enforce to observe", async () => {
  await withTx(async (c) => {
    const s = await one(c, "INSERT INTO policy_state (updated_by, updated_at) VALUES ('system', now()) RETURNING id, mode");
    assert.equal(s.mode, "observe");
    await rejects(c, "INSERT INTO policy_state (updated_by, updated_at) VALUES ('system', now())", [], { code: UNIQUE });
    await c.query("UPDATE policy_state SET mode = 'enforce', updated_by = 'kk:kishore' WHERE id = $1", [s.id]);
    await rejects(c, "UPDATE policy_state SET mode = 'observe', updated_by = 'agent:builder' WHERE id = $1", [s.id], { code: CHECK, message: /only by KK/ });
    await c.query("UPDATE policy_state SET mode = 'observe', updated_by = 'kk:kishore' WHERE id = $1", [s.id]);
  });
});

test("ADR-0006: approval grants are KK-issued, expiring and limited-use", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const ins = "INSERT INTO approval_grant (scope_action, project_id, issued_by, issued_at, expires_at, max_uses, uses) VALUES ('deploy.live', $1, $2, now(), $3, $4, $5)";
    const later = new Date(Date.now() + 3600e3), earlier = new Date(Date.now() - 3600e3);
    await rejects(c, ins, [f.project, "agent:release", later, 1, 0], { code: CHECK, constraint: "approval_grant_issuer_is_kk" });
    await rejects(c, ins, [f.project, "kk:kishore", earlier, 1, 0], { code: CHECK, constraint: "approval_grant_expiry" });
    await rejects(c, ins, [f.project, "kk:kishore", later, 0, 0], { code: CHECK, constraint: "approval_grant_uses" });
    await rejects(c, ins, [f.project, "kk:kishore", later, 1, 2], { code: CHECK, constraint: "approval_grant_uses" });
    await c.query(ins, [f.project, "kk:kishore", later, 1, 0]);
    await rejects(c, "UPDATE approval_grant SET uses = uses + 1 WHERE max_uses = 1 AND uses = 0; UPDATE approval_grant SET uses = uses + 1 WHERE max_uses = 1", [], { code: CHECK, constraint: "approval_grant_uses" });
  });
});

test("ADR-0006: a child envelope can only shrink; envelopes are immutable", async () => {
  await withTx(async (c) => {
    const exp = new Date(Date.now() + 3600e3);
    const root = await one(c, `INSERT INTO capability_envelope (tools, read_paths, write_paths, network, network_allow_list, max_cost_usd, max_tokens, max_concurrency, expires_at, depth)
      VALUES ('{Read,Write,Bash}', '{/work}', '{/work/out}', true, 'registries', 0.5, 100000, 2, $1, 0) RETURNING id`, [exp]);
    const ins = `INSERT INTO capability_envelope (parent_id, tools, read_paths, write_paths, network, network_allow_list, max_cost_usd, max_tokens, max_concurrency, expires_at, depth)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
    const ok = [root.id, "{Read,Bash}", "{/work/src}", "{/work/out/a}", true, "registries", 0.25, 50000, 1, exp, 1];
    const widen = (i, v) => { const a = [...ok]; a[i] = v; return a; };
    await rejects(c, ins, widen(1, "{Read,WebFetch}"), { code: CHECK, message: /widens tools/ });
    await rejects(c, ins, widen(2, "{/etc}"), { code: CHECK, message: /widens paths/ });
    await rejects(c, ins, widen(2, "{/workspace}"), { code: CHECK, message: /widens paths/ });
    await rejects(c, ins, widen(5, "everything"), { code: CHECK, message: /widens network/ });
    await rejects(c, ins, widen(6, 0.75), { code: CHECK, message: /widens cost/ });
    await rejects(c, ins, widen(8, 3), { code: CHECK, message: /widens cost/ });
    await rejects(c, ins, widen(9, new Date(exp.getTime() + 1000)), { code: CHECK, message: /widens cost/ });
    await rejects(c, ins, widen(10, 2), { code: CHECK, message: /depth/ });
    await c.query(ins, ok);
    await rejects(c, "UPDATE capability_envelope SET max_cost_usd = 99 WHERE id = $1", [root.id], { code: CHECK, message: /append-only/ });
  });
});

test("ADR-0006: a reconciled budget reservation must carry actuals", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const r = await run(c, f);
    const b = await one(c, "INSERT INTO budget_reservation (project_id, run_id, provider, reserved_usd, reserved_tokens, updated_at) VALUES ($1, $2, 'anthropic', 0.05, 20000, now()) RETURNING id, status", [f.project, r.id]);
    assert.equal(b.status, "reserved");
    await rejects(c, "UPDATE budget_reservation SET status = 'reconciled' WHERE id = $1", [b.id], { code: CHECK, constraint: "budget_reservation_reconciled_has_actuals" });
    await c.query("UPDATE budget_reservation SET status = 'reconciled', actual_usd = 0.0138, actual_tokens = 16000 WHERE id = $1", [b.id]);
  });
});

test("ADR-0009: policy_denied and budget_exceeded never count as attempts", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const r = await run(c, f);
    const ins = "INSERT INTO run_error (run_id, type, message, retryable, counts_as_attempt) VALUES ($1, $2, 'x', false, $3)";
    for (const t of ["policy_denied", "budget_exceeded"])
      await rejects(c, ins, [r.id, t, true], { code: CHECK, constraint: "run_error_not_an_attempt" });
    await c.query(ins, [r.id, "policy_denied", false]);
    await c.query(ins, [r.id, "provider_error", true]);
  });
});

test("ADR-0008: telemetry, artifacts, mechanism flags and guard metrics hold valid values", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const r = await run(c, f);
    await c.query("INSERT INTO run_telemetry (run_id, turn, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, context_tokens, tool_name, tool_result_bytes) VALUES ($1, 1, 1339, 250, 11363, 4068, 16000, 'Bash', 412)", [r.id]);
    await rejects(c, "INSERT INTO artifact (run_id, kind, bytes, sha256, storage_path) VALUES ($1, 'log', 20000, 'nothex', '/a')", [r.id], { code: CHECK, constraint: "artifact_values" });
    const a = await one(c, "INSERT INTO artifact (run_id, kind, bytes, sha256, storage_path, excerpt_head, excerpt_tail) VALUES ($1, 'log', 20000, $2, '/a', 'head', 'tail') RETURNING id", [r.id, h("log")]);
    await c.query("INSERT INTO log_receipt (artifact_id, model, verdict, exit_code, quotes, verified) VALUES ($1, 'claude-haiku-5-5', 'fail', 1, '{\"FAIL test_x\"}', true)", [a.id]);
    await c.query("INSERT INTO mechanism_flag (role, mechanism, changed_by, updated_at) VALUES ('builder', 'archive', 'kk:kishore', now())");
    await rejects(c, "INSERT INTO mechanism_flag (role, mechanism, changed_by, updated_at) VALUES ('builder', 'archive', 'kk:kishore', now())", [], { code: UNIQUE });
    const flag = await one(c, "SELECT enabled FROM mechanism_flag WHERE role = 'builder' AND mechanism = 'archive'");
    assert.equal(flag.enabled, false, "mechanisms default to off (baseline first)");
    const gm = "INSERT INTO guard_metric (role, window_end, codex_first_pass_rate, ci_first_green_rate, opus_escalation_rate, deadlocks, rollbacks, baseline) VALUES ('builder', now(), $1, 0.9, 0.1, 0, 0, true)";
    await rejects(c, gm, [1.2], { code: CHECK, constraint: "guard_metric_values" });
    await c.query(gm, [0.75]);
  });
});

test("ADR-0006: provenance defaults to unknown and accepts the six types", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const m = await one(c, "INSERT INTO memory_item (project_id, type, content, source, observed_at) VALUES ($1, 'observation', 'x', 'test', now()) RETURNING provenance", [f.project]);
    assert.equal(m.provenance, "unknown");
    await c.query("INSERT INTO memory_item (project_id, type, content, source, observed_at, provenance, source_ref) VALUES ($1, 'decision', 'approved', 'card', now(), 'kk_approved', 'approval:1')", [f.project]);
    await rejects(c, "INSERT INTO memory_item (project_id, type, content, source, observed_at, provenance) VALUES ($1, 'decision', 'x', 'y', now(), 'rumour')", [f.project], { code: "22P02" });
  });
});
