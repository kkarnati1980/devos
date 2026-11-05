-- M1.1 v1.1 integrity rules for the ADR-0006/0008/0009 entities (docs/modules/M1.1.md, adoption plan v1.0.0).
-- Check constraints and triggers only. Every rule raises check_violation (23514).
-- KK identity convention: issuer/updater strings for KK are 'kk:<tailscale-login>' (ADR-0006 §3, O4).

-- ---------- policy rules and state ----------
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_values" CHECK ("version" >= 1);
ALTER TABLE "policy_state" ADD CONSTRAINT "policy_state_singleton" CHECK ("singleton");

-- Mode only rises (observe -> enforce) unless KK lowers it.
CREATE FUNCTION devos_policy_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mode = 'enforce' AND NEW.mode = 'observe' AND NEW.updated_by NOT LIKE 'kk:%' THEN
    RAISE EXCEPTION 'policy mode can be lowered to observe only by KK (updated_by %)', NEW.updated_by
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_state_mode_guard BEFORE UPDATE OF mode ON "policy_state"
  FOR EACH ROW EXECUTE FUNCTION devos_policy_mode_guard();

-- ---------- policy decisions: gapless, hash-linked, append-only receipts ----------
ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_seq_positive" CHECK ("seq" >= 1);
ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_hash_format" CHECK (
  "hash" ~ '^[0-9a-f]{64}$' AND ("prev_hash" IS NULL OR "prev_hash" ~ '^[0-9a-f]{64}$'));

CREATE FUNCTION devos_policy_decision_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq integer;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('policy_decision:' || NEW.chain));
  SELECT seq, hash INTO last_seq, last_hash FROM policy_decision
    WHERE chain = NEW.chain ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(last_seq, 0) + 1 THEN
    RAISE EXCEPTION 'policy_decision chain %: seq % is not the next (expected %)', NEW.chain, NEW.seq, COALESCE(last_seq, 0) + 1
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prev_hash IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'policy_decision chain %: prev_hash does not match the previous receipt', NEW.chain
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_decision_chain BEFORE INSERT ON "policy_decision"
  FOR EACH ROW EXECUTE FUNCTION devos_policy_decision_chain();
CREATE TRIGGER policy_decision_no_update BEFORE UPDATE OR DELETE ON "policy_decision"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();
CREATE TRIGGER policy_decision_no_truncate BEFORE TRUNCATE ON "policy_decision"
  FOR EACH STATEMENT EXECUTE FUNCTION devos_reject_update();

-- ---------- approval grants: KK-issued, scoped, expiring, limited-use ----------
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_issuer_is_kk" CHECK ("issued_by" LIKE 'kk:%');
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_uses" CHECK ("max_uses" >= 1 AND "uses" >= 0 AND "uses" <= "max_uses");
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_expiry" CHECK ("expires_at" > "issued_at");
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_sha_format" CHECK ("sha" IS NULL OR "sha" ~ '^[0-9a-f]{40}$');

-- ---------- capability envelopes: a child can only shrink (ADR-0006 §2) ----------
ALTER TABLE "capability_envelope" ADD CONSTRAINT "capability_envelope_limits" CHECK (
  "max_cost_usd" >= 0 AND "max_tokens" >= 0 AND "max_concurrency" >= 1 AND "depth" >= 0
  AND (("parent_id" IS NULL) = ("depth" = 0))
  AND ("network" OR "network_allow_list" IS NULL));

CREATE FUNCTION devos_paths_within(child text[], parent text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(child) AS c
    WHERE NOT EXISTS (
      SELECT 1 FROM unnest(parent) AS p
      WHERE c = p OR starts_with(c, rtrim(p, '/') || '/')))
$$;

CREATE FUNCTION devos_envelope_shrinks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p capability_envelope%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM capability_envelope WHERE id = NEW.parent_id;
  IF NEW.depth <> p.depth + 1 THEN
    RAISE EXCEPTION 'envelope depth must be parent depth + 1' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (NEW.tools <@ p.tools) THEN
    RAISE EXCEPTION 'envelope widens tools' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT devos_paths_within(NEW.read_paths, p.read_paths) OR NOT devos_paths_within(NEW.write_paths, p.write_paths) THEN
    RAISE EXCEPTION 'envelope widens paths' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.network AND (NOT p.network OR NEW.network_allow_list IS DISTINCT FROM p.network_allow_list) THEN
    RAISE EXCEPTION 'envelope widens network' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.max_cost_usd > p.max_cost_usd OR NEW.max_tokens > p.max_tokens
     OR NEW.max_concurrency > p.max_concurrency OR NEW.expires_at > p.expires_at THEN
    RAISE EXCEPTION 'envelope widens cost, tokens, concurrency or expiry' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capability_envelope_shrinks BEFORE INSERT ON "capability_envelope"
  FOR EACH ROW EXECUTE FUNCTION devos_envelope_shrinks();
-- Envelopes are issued, never edited (a widened envelope would bypass the shrink check).
CREATE TRIGGER capability_envelope_immutable BEFORE UPDATE ON "capability_envelope"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();

-- ---------- budget reservations ----------
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_values" CHECK (
  "reserved_usd" >= 0 AND "reserved_tokens" >= 0
  AND ("actual_usd" IS NULL OR "actual_usd" >= 0) AND ("actual_tokens" IS NULL OR "actual_tokens" >= 0));
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_reconciled_has_actuals" CHECK (
  "status" <> 'reconciled' OR ("actual_usd" IS NOT NULL AND "actual_tokens" IS NOT NULL));

-- ---------- run events: gapless per run (ADR-0009 §2) ----------
-- A gap is rejected here; a duplicate seq is rejected by the unique (run_id, seq) index.
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_seq_positive" CHECK ("seq" >= 1);
CREATE FUNCTION devos_run_event_gapless() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('run_event:' || NEW.run_id::text));
  SELECT max(seq) INTO last_seq FROM run_event WHERE run_id = NEW.run_id;
  IF NEW.seq > COALESCE(last_seq, 0) + 1 THEN
    RAISE EXCEPTION 'run_event for run %: seq % leaves a gap (expected %)', NEW.run_id, NEW.seq, COALESCE(last_seq, 0) + 1
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_event_gapless BEFORE INSERT ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION devos_run_event_gapless();
CREATE TRIGGER run_event_immutable BEFORE UPDATE ON "run_event"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();

-- ---------- run errors: policy and budget stops never count as attempts (ADR-0006, ADR-0009 §3) ----------
ALTER TABLE "run_error" ADD CONSTRAINT "run_error_not_an_attempt" CHECK (
  "type" NOT IN ('policy_denied', 'budget_exceeded') OR NOT "counts_as_attempt");

-- ---------- telemetry, artifacts, guard metrics (ADR-0008) ----------
ALTER TABLE "run_telemetry" ADD CONSTRAINT "run_telemetry_nonneg" CHECK (
  "turn" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0
  AND "cache_write_tokens" >= 0 AND "context_tokens" >= 0 AND ("tool_result_bytes" IS NULL OR "tool_result_bytes" >= 0));
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_values" CHECK ("bytes" >= 0 AND "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "guard_metric" ADD CONSTRAINT "guard_metric_values" CHECK (
  "window_size" >= 1 AND "deadlocks" >= 0 AND "rollbacks" >= 0
  AND "codex_first_pass_rate" BETWEEN 0 AND 1 AND "ci_first_green_rate" BETWEEN 0 AND 1
  AND "opus_escalation_rate" BETWEEN 0 AND 1);
