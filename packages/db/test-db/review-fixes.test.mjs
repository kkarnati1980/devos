// M1.1 v1.3: fixes for Codex review PR7-r1 (AT14-AT18). Each test proves the bypass Codex described is closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTx, rejects, one, fixture, sha } from "./helpers.mjs";

const CHECK = "23514";

test("AT14 a commit's sha and project are fixed once stored; verdicts cannot be deleted", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const other = await one(c, "INSERT INTO project (slug, name, updated_at) VALUES ('other-project', 'Other', now()) RETURNING id");
    const v = await one(c, "INSERT INTO review_verdict (commit_id, round, reviewer, verdict, summary, raw) VALUES ($1, 1, 'codex', 'pass', 's', '{}') RETURNING id", [f.commit]);
    await rejects(c, "UPDATE commit SET sha = $2 WHERE id = $1", [f.commit, sha("b")], { code: CHECK, message: /cannot change/ });
    await rejects(c, "UPDATE commit SET project_id = $2 WHERE id = $1", [f.commit, other.id], { code: CHECK, message: /cannot change/ });
    await c.query("UPDATE commit SET branch = 'kishore/devos-27-x' WHERE id = $1", [f.commit]);
    await rejects(c, "DELETE FROM review_verdict WHERE id = $1", [v.id], { code: CHECK, message: /append-only/ });
    await rejects(c, "TRUNCATE review_verdict CASCADE", [], { code: CHECK, message: /append-only/ });
  });
});

test("AT15 envelope paths must be canonical absolute paths, so '..' cannot escape the parent", async () => {
  await withTx(async (c) => {
    const exp = new Date(Date.now() + 3600e3);
    const ins = `INSERT INTO capability_envelope (tools, read_paths, write_paths, network, max_cost_usd, max_tokens, max_concurrency, expires_at, depth)
      VALUES ('{Read}', $1, $2, false, 0.5, 1000, 1, $3, 0) RETURNING id`;
    for (const bad of ["{work}", "{/work/../etc}", "{/work/..}", "{/work/./x}", "{/work//x}", "{/work/}", "{\"/work/a\nb\"}", "{/work,NULL}"]) {
      await rejects(c, ins, [bad, "{/work}", exp], { code: CHECK, constraint: "capability_envelope_paths_canonical" });
      await rejects(c, ins, ["{/work}", bad, exp], { code: CHECK, constraint: "capability_envelope_paths_canonical" });
    }
    const root = await one(c, ins, ["{/work}", "{/work/out}", exp]);
    await one(c, ins, ["{/}", "{/work/a.b/..c/x}", exp]);
    // The Codex scenario: a child under /work/out that climbs out via '..' is now rejected before the shrink check.
    await rejects(c, `INSERT INTO capability_envelope (parent_id, tools, read_paths, write_paths, network, max_cost_usd, max_tokens, max_concurrency, expires_at, depth)
      VALUES ($1, '{Read}', '{/work}', '{/work/out/../../etc}', false, 0.1, 10, 1, $2, 1)`, [root.id, exp], { code: CHECK, constraint: "capability_envelope_paths_canonical" });
  });
});

test("AT16 the policy_state singleton cannot be deleted or truncated to reset enforce to observe", async () => {
  await withTx(async (c) => {
    const s = await one(c, "INSERT INTO policy_state (mode, updated_by, updated_at) VALUES ('enforce', 'kk:kishore', now()) RETURNING id");
    await rejects(c, "DELETE FROM policy_state WHERE id = $1", [s.id], { code: CHECK, message: /append-only/ });
    await rejects(c, "TRUNCATE policy_state", [], { code: CHECK, message: /append-only/ });
    const row = await one(c, "SELECT mode FROM policy_state WHERE id = $1", [s.id]);
    assert.equal(row.mode, "enforce");
  });
});

test("AT17 run events cannot be deleted or truncated", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const r = await one(c, "INSERT INTO run (task_id, project_id, role, model, max_turns, max_seconds, max_cost_usd, updated_at) VALUES ($1, $2, 'builder', 'claude-sonnet-5-5', 12, 300, 0.5, now()) RETURNING id", [f.task, f.project]);
    const ins = "INSERT INTO run_event (run_id, seq, type, payload) VALUES ($1, $2, 'status', '{}')";
    await c.query(ins, [r.id, 1]);
    await c.query(ins, [r.id, 2]);
    await rejects(c, "DELETE FROM run_event WHERE run_id = $1 AND seq = 2", [r.id], { code: CHECK, message: /append-only/ });
    await rejects(c, "TRUNCATE run_event", [], { code: CHECK, message: /append-only/ });
    // Deleting the last event and re-inserting a different seq 2 is therefore impossible.
    const n = await one(c, "SELECT count(*)::int AS n FROM run_event WHERE run_id = $1", [r.id]);
    assert.equal(n.n, 2);
  });
});

test("AT18 a milestone closes only with an approved gate approval of the same project, which then stays fixed", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const other = await one(c, "INSERT INTO project (slug, name, updated_at) VALUES ('other-project', 'Other', now()) RETURNING id");
    const appr = (p, status) => one(c, "INSERT INTO approval (project_id, gate, action, target, reason, status, decided_at, updated_at) VALUES ($1, 'decision', 'close gate', 'G1', 'r', $2, $3, now()) RETURNING id",
      [p, status, status === "pending" ? null : new Date()]);
    const pending = await appr(f.project, "pending");
    const rejected = await appr(f.project, "rejected");
    const foreign = await appr(other.id, "approved");
    const ok = await appr(f.project, "approved");
    const close = "UPDATE milestone SET closed_at = now(), gate_approval_id = $2 WHERE id = $1";
    await rejects(c, "UPDATE milestone SET closed_at = now() WHERE id = $1", [f.milestone], { code: CHECK, constraint: "milestone_closed_has_gate_approval" });
    await rejects(c, close, [f.milestone, pending.id], { code: CHECK, message: /not approved/ });
    await rejects(c, close, [f.milestone, rejected.id], { code: CHECK, message: /not approved/ });
    await rejects(c, close, [f.milestone, foreign.id], { code: CHECK, message: /different project/ });
    await rejects(c, `INSERT INTO milestone (project_id, ordinal, name, gate_name, closed_at, gate_approval_id, updated_at) VALUES ($1, 2, 'P2', 'G2', now(), $2, now())`, [f.project, pending.id], { code: CHECK, message: /not approved/ });
    // An open milestone may point at a pending approval (the gate card is waiting for KK).
    await c.query("UPDATE milestone SET gate_approval_id = $2 WHERE id = $1", [f.milestone, pending.id]);
    await c.query(close, [f.milestone, ok.id]);
    await rejects(c, "UPDATE approval SET status = 'rejected' WHERE id = $1", [ok.id], { code: CHECK, message: /closed a milestone gate/ });
    await rejects(c, "UPDATE approval SET project_id = $2 WHERE id = $1", [ok.id, other.id], { code: CHECK, message: /closed a milestone gate/ });
    // Approvals not tied to a closed gate can still be decided.
    await c.query("UPDATE approval SET status = 'approved', decided_at = now() WHERE id = $1", [pending.id]);
  });
});
