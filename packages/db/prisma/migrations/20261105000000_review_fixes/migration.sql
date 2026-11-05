-- M1.1 v1.3: fixes for Codex reviews PR7-r1 and PR7-r2 and PR7-r3 (docs/modules/M1.1.md, AT14-AT21).
-- Check constraints and triggers only; no table or column changes. Every rule raises check_violation (23514).

-- ---------- F1: a commit's identity is fixed once stored ----------
-- Verdicts, evidence and deploys reference commit.id; if sha or project_id could change, a PASS stored
-- for one SHA could be moved onto different code (D1).
CREATE FUNCTION devos_commit_identity_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sha IS DISTINCT FROM OLD.sha OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'commit %: sha and project_id cannot change once stored', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commit_identity_fixed BEFORE UPDATE OF sha, project_id ON "commit"
  FOR EACH ROW EXECUTE FUNCTION devos_commit_identity_fixed();

-- Verdicts were already immutable on UPDATE; they are evidence and are kept after a purge (DR v1.3.1),
-- so DELETE and TRUNCATE are rejected too.
CREATE TRIGGER review_verdict_no_delete BEFORE DELETE ON "review_verdict"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();
CREATE TRIGGER review_verdict_no_truncate BEFORE TRUNCATE ON "review_verdict"
  FOR EACH STATEMENT EXECUTE FUNCTION devos_reject_update();

-- ---------- F2: envelope paths are canonical absolute paths ----------
-- The shrink check compares paths as strings, so '/repo/../etc' or '/repo//x' would pass as "inside /repo".
-- Each path must start with '/', and contain no '.' or '..' segment, no empty segment ('//'),
-- no trailing '/' (except '/' itself), no control character, and no NULL element.
CREATE FUNCTION devos_paths_canonical(paths text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(paths, NULL) IS NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(paths) AS p
    WHERE NOT (
      p ~ '^/'
      AND (p = '/' OR p !~ '/$')
      AND p !~ '//'
      AND p !~ '(^|/)\.\.?(/|$)'
      AND p !~ '[[:cntrl:]]'))
$$;
ALTER TABLE "capability_envelope" ADD CONSTRAINT "capability_envelope_paths_canonical" CHECK (
  devos_paths_canonical("read_paths") AND devos_paths_canonical("write_paths"));

-- ---------- F3: the policy mode cannot be reset by deleting the singleton ----------
-- Deleting and re-inserting policy_state would restore the default 'observe' without KK.
CREATE TRIGGER policy_state_no_delete BEFORE DELETE ON "policy_state"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();
CREATE TRIGGER policy_state_no_truncate BEFORE TRUNCATE ON "policy_state"
  FOR EACH STATEMENT EXECUTE FUNCTION devos_reject_update();

-- ---------- F4: run events are append-only (delete and truncate too) ----------
CREATE TRIGGER run_event_no_delete BEFORE DELETE ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();
CREATE TRIGGER run_event_no_truncate BEFORE TRUNCATE ON "run_event"
  FOR EACH STATEMENT EXECUTE FUNCTION devos_reject_update();

-- ---------- F5: a milestone closes only through KK's approved gate ----------
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_closed_has_gate_approval" CHECK (
  "closed_at" IS NULL OR "gate_approval_id" IS NOT NULL);

CREATE FUNCTION devos_milestone_gate_approved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status approval_status;
  a_project uuid;
BEGIN
  -- No approval at all is left to the milestone_closed_has_gate_approval check.
  IF NEW.closed_at IS NULL OR NEW.gate_approval_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Materialise the conflict with a concurrent change to this approval (PR7-r2): a no-op write takes the
  -- row lock and creates a new row version. A concurrent status change then waits for this transaction
  -- (READ COMMITTED: its trigger sees the closed milestone) or fails with a serialization error
  -- (REPEATABLE READ / SERIALIZABLE). If the other change came first, this statement waits, then reads
  -- the committed status below. The trigger on approval fires only for status / project_id, not here.
  UPDATE approval SET updated_at = updated_at WHERE id = NEW.gate_approval_id;
  SELECT status, project_id INTO a_status, a_project FROM approval WHERE id = NEW.gate_approval_id;
  IF a_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'milestone %: gate approval is not approved (status %)', NEW.id, a_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF a_project IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'milestone %: gate approval belongs to a different project', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER milestone_gate_approved BEFORE INSERT OR UPDATE OF closed_at, gate_approval_id, project_id ON "milestone"
  FOR EACH ROW EXECUTE FUNCTION devos_milestone_gate_approved();

-- An approval that closed a milestone cannot be withdrawn or moved afterwards.
CREATE FUNCTION devos_approval_keeps_closed_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.project_id IS DISTINCT FROM OLD.project_id)
     AND EXISTS (SELECT 1 FROM milestone WHERE gate_approval_id = OLD.id AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'approval %: it closed a milestone gate, so its status and project are fixed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_keeps_closed_gate BEFORE UPDATE OF status, project_id ON "approval"
  FOR EACH ROW EXECUTE FUNCTION devos_approval_keeps_closed_gate();

-- ---------- PR7-r2 F1: a child envelope needs an existing parent before any comparison ----------
-- In a multi-row INSERT, a child can precede its parent. The parent lookup then finds nothing, every
-- comparison against the NULL record is NULL, no IF fires, and the FK is checked only at statement end,
-- when the parent exists. Reject a missing parent, and treat any NULL comparison as a widening.
CREATE OR REPLACE FUNCTION devos_envelope_shrinks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p capability_envelope%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM capability_envelope WHERE id = NEW.parent_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope parent % not found (insert the parent first)', NEW.parent_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.depth = p.depth + 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'envelope depth must be parent depth + 1' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.tools <@ p.tools) IS NOT TRUE THEN
    RAISE EXCEPTION 'envelope widens tools' USING ERRCODE = 'check_violation';
  END IF;
  IF (devos_paths_within(NEW.read_paths, p.read_paths) AND devos_paths_within(NEW.write_paths, p.write_paths)) IS NOT TRUE THEN
    RAISE EXCEPTION 'envelope widens paths' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.network AND ((p.network AND NEW.network_allow_list IS NOT DISTINCT FROM p.network_allow_list) IS NOT TRUE) THEN
    RAISE EXCEPTION 'envelope widens network' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.max_cost_usd <= p.max_cost_usd AND NEW.max_tokens <= p.max_tokens
      AND NEW.max_concurrency <= p.max_concurrency AND NEW.expires_at <= p.expires_at) IS NOT TRUE THEN
    RAISE EXCEPTION 'envelope widens cost, tokens, concurrency or expiry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------- PR7-r3: snapshot-safe uniqueness guards ----------
-- requirements_doc_one_approved and vault_secret_global_unique serialise writers with an advisory lock,
-- then check with EXISTS. That is correct in READ COMMITTED (each statement takes a fresh snapshot after
-- the lock) and in SERIALIZABLE (SSI aborts the write skew), but in REPEATABLE READ the EXISTS can read a
-- snapshot taken before the other writer committed. Those two guards therefore refuse REPEATABLE READ.
CREATE FUNCTION devos_require_fresh_snapshot(guard text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION '%: not allowed under REPEATABLE READ (use READ COMMITTED or SERIALIZABLE)', guard
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION devos_one_approved_requirements_doc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    PERFORM devos_require_fresh_snapshot('requirements_doc approval');
    PERFORM pg_advisory_xact_lock(hashtext('requirements_doc:' || NEW.project_id::text));
    IF EXISTS (SELECT 1 FROM requirements_doc
               WHERE project_id = NEW.project_id AND status = 'approved' AND id <> NEW.id) THEN
      RAISE EXCEPTION 'project % already has an approved requirements doc', NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION devos_vault_global_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    PERFORM devos_require_fresh_snapshot('global vault secret');
    PERFORM pg_advisory_xact_lock(hashtext('vault_secret:global:' || NEW.name));
    IF EXISTS (SELECT 1 FROM vault_secret WHERE project_id IS NULL AND name = NEW.name AND id <> NEW.id) THEN
      RAISE EXCEPTION 'global vault secret % already exists', NEW.name USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
