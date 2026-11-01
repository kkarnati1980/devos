// M1.1 AT7 (D1 in the database) and AT8 (append-only audit; immutable verdicts).
import { test } from "node:test";
import { withTx, rejects, one, fixture, sha } from "./helpers.mjs";

const CHECK = "23514";

async function verdict(c, commitId, round, v) {
  return one(c, "INSERT INTO review_verdict (commit_id, round, reviewer, verdict, summary, raw) VALUES ($1, $2, 'codex', $3, 's', '{}') RETURNING id", [commitId, round, v]);
}
const DEPLOY = "INSERT INTO deploy (project_id, commit_id, environment, review_verdict_id, updated_at) VALUES ($1, $2, $3, $4, now()) RETURNING id";

test("AT7 live deploy needs a PASS verdict for the same commit", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const other = await one(c, "INSERT INTO commit (project_id, sha) VALUES ($1, $2) RETURNING id", [f.project, sha("b")]);
    const changes = await verdict(c, f.commit, 1, "changes_requested");
    const passOther = await verdict(c, other.id, 1, "pass");
    const pass = await verdict(c, f.commit, 2, "pass");

    await rejects(c, DEPLOY, [f.project, f.commit, "live", null], { code: CHECK, message: /no review verdict/ });
    await rejects(c, DEPLOY, [f.project, f.commit, "live", changes.id], { code: CHECK, message: /not PASS/ });
    await rejects(c, DEPLOY, [f.project, f.commit, "live", passOther.id], { code: CHECK, message: /different commit/ });
    const ok = await one(c, DEPLOY, [f.project, f.commit, "live", pass.id]);

    // A preview deploy needs no verdict.
    const prev = await one(c, DEPLOY, [f.project, f.commit, "preview", null]);
    // Promoting it to live without a verdict, or swapping in a wrong verdict, is also refused.
    await rejects(c, "UPDATE deploy SET environment = 'live' WHERE id = $1", [prev.id], { code: CHECK, message: /no review verdict/ });
    await rejects(c, "UPDATE deploy SET review_verdict_id = $2 WHERE id = $1", [ok.id, passOther.id], { code: CHECK, message: /different commit/ });
  });
});

test("AT7 a deploy's commit must belong to its project", async () => {
  await withTx(async (c) => {
    const a = await fixture(c, "proj-a");
    const b = await fixture(c, "proj-b");
    await rejects(c, DEPLOY, [a.project, b.commit, "preview", null], { code: CHECK, message: /does not belong/ });
  });
});

test("AT8 a stored verdict cannot be edited (so a PASS cannot be swapped)", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const v = await verdict(c, f.commit, 1, "changes_requested");
    await rejects(c, "UPDATE review_verdict SET verdict = 'pass' WHERE id = $1", [v.id], { code: CHECK, message: /append-only/ });
  });
});

test("AT8 audit_event: insert works; update and truncate are rejected", async () => {
  await withTx(async (c) => {
    const f = await fixture(c);
    const e = await one(c, "INSERT INTO audit_event (actor, role, project_id, sha, cost_usd, action, summary) VALUES ('agent', 'builder', $1, $2, 0.01, 'commit', 'Builder committed M1.1') RETURNING id", [f.project, sha("a")]);
    await rejects(c, "UPDATE audit_event SET summary = 'rewritten' WHERE id = $1", [e.id], { code: CHECK, message: /append-only/ });
    await rejects(c, "TRUNCATE audit_event", [], { code: CHECK, message: /append-only/ });
    await rejects(c, "INSERT INTO audit_event (actor, action, summary, sha) VALUES ('system', 'x', 'y', 'nothex')", [], { code: CHECK, constraint: "audit_event_sha_format" });
  });
});
