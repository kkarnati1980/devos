// M1.1 v1.3: fixes for Codex review PR7-r1 (AT14-AT18). Each test proves the bypass Codex described is closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { withTx, rejects, one, fixture, sha, url } from "./helpers.mjs";

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

// ---------- PR7-r2 ----------

test("AT19 a child envelope placed before its parent in one multi-row INSERT is rejected", async () => {
  await withTx(async (c) => {
    const exp = new Date(Date.now() + 3600e3);
    const parent = "00000000-0000-4000-8000-000000000001", child = "00000000-0000-4000-8000-000000000002";
    // The Codex scenario: empty paths, network off, and every limit wider than the parent's.
    await rejects(c, `INSERT INTO capability_envelope (id, parent_id, tools, read_paths, write_paths, network, max_cost_usd, max_tokens, max_concurrency, expires_at, depth) VALUES
      ($1, $2, '{Read,Write,Bash,WebFetch}', '{}', '{}', false, 99, 9999999, 50, $4, 7),
      ($2, NULL, '{Read}', '{/work}', '{/work}', false, 0.1, 10, 1, $3, 0)`,
      [child, parent, exp, new Date(exp.getTime() + 864e5)], { code: CHECK, message: /parent .* not found/ });
    // Parent first in the same statement is fine.
    await c.query(`INSERT INTO capability_envelope (id, parent_id, tools, read_paths, write_paths, network, max_cost_usd, max_tokens, max_concurrency, expires_at, depth) VALUES
      ($2, NULL, '{Read}', '{/work}', '{/work}', false, 0.1, 10, 1, $3, 0),
      ($1, $2, '{Read}', '{}', '{}', false, 0.1, 10, 1, $3, 1)`, [child, parent, exp]);
  });
});

/** Committed fixture for the two-session tests: project, approved approval, open milestone. */
async function raceFixture(slug) {
  const c = new pg.Client({ connectionString: url() });
  await c.connect();
  const p = await one(c, "INSERT INTO project (slug, name, updated_at) VALUES ($1, 'Race', now()) RETURNING id", [slug]);
  const a = await one(c, "INSERT INTO approval (project_id, gate, action, target, reason, status, decided_at, updated_at) VALUES ($1, 'decision', 'close gate', 'G1', 'r', 'approved', now(), now()) RETURNING id", [p.id]);
  const m = await one(c, "INSERT INTO milestone (project_id, ordinal, name, gate_name, updated_at) VALUES ($1, 1, 'P1', 'G1', now()) RETURNING id", [p.id]);
  const cleanup = async () => {
    await c.query("DELETE FROM milestone WHERE id = $1", [m.id]);
    await c.query("DELETE FROM approval WHERE id = $1", [a.id]);
    await c.query("DELETE FROM project WHERE id = $1", [p.id]);
    await c.end();
  };
  return { approval: a.id, milestone: m.id, cleanup };
}
async function session(isolation) {
  const s = new pg.Client({ connectionString: url() });
  await s.connect();
  await s.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  return s;
}
const settle = (p) => p.then(() => null, (e) => e);
const CLOSE = "UPDATE milestone SET closed_at = now(), gate_approval_id = $2 WHERE id = $1";
const REJECT = "UPDATE approval SET status = 'rejected' WHERE id = $1";

for (const iso of ["READ COMMITTED", "REPEATABLE READ"]) {
  test(`AT20 (${iso}) close first, then a concurrent rejection of the same approval: the rejection fails`, async () => {
    const f = await raceFixture(`race-a-${iso === "READ COMMITTED" ? "rc" : "rr"}`);
    const A = await session(iso), B = await session(iso);
    try {
      await B.query("SELECT 1"); // B's snapshot predates A's commit
      await A.query(CLOSE, [f.milestone, f.approval]);
      const b = settle(B.query(REJECT, [f.approval])); // blocks on A
      await A.query("COMMIT");
      const err = await b;
      assert.ok(err, "the concurrent rejection must fail");
      assert.ok(["23514", "40001"].includes(err.code), `${err.code} ${err.message}`);
      await B.query("ROLLBACK");
      const s = await one(A, "SELECT status FROM approval WHERE id = $1", [f.approval]);
      assert.equal(s.status, "approved");
    } finally {
      await A.end(); await B.end(); await f.cleanup();
    }
  });

  test(`AT20 (${iso}) rejection first, then a concurrent close with that approval: the close fails`, async () => {
    const f = await raceFixture(`race-b-${iso === "READ COMMITTED" ? "rc" : "rr"}`);
    const A = await session(iso), B = await session(iso);
    try {
      await A.query("SELECT 1");
      await B.query(REJECT, [f.approval]);
      const a = settle(A.query(CLOSE, [f.milestone, f.approval])); // blocks on B
      await B.query("COMMIT");
      const err = await a;
      assert.ok(err, "the concurrent close must fail");
      assert.ok(["23514", "40001"].includes(err.code), `${err.code} ${err.message}`);
      await A.query("ROLLBACK");
      const m = await one(B, "SELECT closed_at FROM milestone WHERE id = $1", [f.milestone]);
      assert.equal(m.closed_at, null);
    } finally {
      await A.end(); await B.end(); await f.cleanup();
    }
  });
}

// ---------- PR7-r3: concurrent uniqueness guards ----------
const REQ = "INSERT INTO requirements_doc (project_id, version, repo_path, status, updated_at) VALUES ($1, $2, 'docs/requirements.md', 'approved', now())";
const VAULT = "INSERT INTO vault_secret (project_id, name, ciphertext, nonce, key_version, updated_at) VALUES (NULL, $1, '\\x01', '\\x02', 1, now())";

async function committedProject(slug) {
  const c = new pg.Client({ connectionString: url() });
  await c.connect();
  const p = await one(c, "INSERT INTO project (slug, name, updated_at) VALUES ($1, 'Race', now()) RETURNING id", [slug]);
  return { id: p.id, cleanup: async (secret) => {
    await c.query("DELETE FROM requirements_doc WHERE project_id = $1", [p.id]);
    if (secret) await c.query("DELETE FROM vault_secret WHERE project_id IS NULL AND name = $1", [secret]);
    await c.query("DELETE FROM project WHERE id = $1", [p.id]);
    await c.end();
  } };
}

test("AT21 under REPEATABLE READ both uniqueness guards refuse to run", async () => {
  const p = await committedProject("race-rr-guard");
  const s = await session("REPEATABLE READ");
  try {
    await rejects(s, REQ, [p.id, 1], { code: CHECK, message: /REPEATABLE READ/ });
    await rejects(s, VAULT, ["RR_GLOBAL"], { code: CHECK, message: /REPEATABLE READ/ });
    // Non-approved docs and per-project secrets are not affected.
    await s.query("INSERT INTO requirements_doc (project_id, version, repo_path, status, updated_at) VALUES ($1, 1, 'docs/requirements.md', 'draft', now())", [p.id]);
    await s.query("ROLLBACK");
  } finally {
    await s.end(); await p.cleanup();
  }
});

for (const iso of ["READ COMMITTED", "SERIALIZABLE"]) {
  const tag = iso === "READ COMMITTED" ? "rc" : "sr";
  test(`AT21 (${iso}) two concurrent approved requirements docs: exactly one commits`, async () => {
    const p = await committedProject(`race-req-${tag}`);
    const A = await session(iso), B = await session(iso);
    try {
      await A.query("SELECT 1"); await B.query("SELECT 1"); // both snapshots predate either insert
      await A.query(REQ, [p.id, 1]);
      const b = settle(B.query(REQ, [p.id, 2]).then(() => B.query("COMMIT")));
      await A.query("COMMIT");
      const err = await b;
      assert.ok(err, "the second approved doc must fail");
      assert.ok(["23514", "40001"].includes(err.code), `${err.code} ${err.message}`);
      await B.query("ROLLBACK").catch(() => {});
      const n = await one(A, "SELECT count(*)::int AS n FROM requirements_doc WHERE project_id = $1 AND status = 'approved'", [p.id]);
      assert.equal(n.n, 1);
    } finally {
      await A.end(); await B.end(); await p.cleanup();
    }
  });

  test(`AT21 (${iso}) two concurrent global vault secrets with one name: exactly one commits`, async () => {
    const name = `RACE_GLOBAL_${tag.toUpperCase()}`;
    const p = await committedProject(`race-vault-${tag}`);
    const A = await session(iso), B = await session(iso);
    try {
      await A.query("SELECT 1"); await B.query("SELECT 1");
      await A.query(VAULT, [name]);
      const b = settle(B.query(VAULT, [name]).then(() => B.query("COMMIT")));
      await A.query("COMMIT");
      const err = await b;
      assert.ok(err, "the second global secret must fail");
      assert.ok(["23514", "40001"].includes(err.code), `${err.code} ${err.message}`);
      await B.query("ROLLBACK").catch(() => {});
      const n = await one(A, "SELECT count(*)::int AS n FROM vault_secret WHERE project_id IS NULL AND name = $1", [name]);
      assert.equal(n.n, 1);
    } finally {
      await A.end(); await B.end(); await p.cleanup(name);
    }
  });
}
