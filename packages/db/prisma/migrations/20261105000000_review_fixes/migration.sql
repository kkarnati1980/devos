-- M1.1 v1.3: fixes for Codex review PR7-r1 (docs/modules/M1.1.md, AT14-AT18).
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
