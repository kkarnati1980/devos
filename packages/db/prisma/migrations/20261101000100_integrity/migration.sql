-- M1.1 integrity rules Prisma's schema language does not model (docs/modules/M1.1.md).
-- Check constraints and triggers only; no tables or columns are created here.
-- Error code for every rule: check_violation (23514), so callers can map it uniformly.

-- ---------- formats ----------
ALTER TABLE "project" ADD CONSTRAINT "project_slug_format" CHECK ("slug" ~ '^[a-z0-9-]{2,40}$');
ALTER TABLE "commit" ADD CONSTRAINT "commit_sha_format" CHECK ("sha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "requirements_doc" ADD CONSTRAINT "requirements_doc_sha_format" CHECK ("commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "module" ADD CONSTRAINT "module_merged_sha_format" CHECK ("merged_sha" IS NULL OR "merged_sha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "run" ADD CONSTRAINT "run_sha_format" CHECK (("start_sha" IS NULL OR "start_sha" ~ '^[0-9a-f]{40}$') AND ("end_sha" IS NULL OR "end_sha" ~ '^[0-9a-f]{40}$'));
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_sha_format" CHECK ("sha" IS NULL OR "sha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_report_time_format" CHECK ("report_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ---------- ranges ----------
ALTER TABLE "project" ADD CONSTRAINT "project_lanes_range" CHECK ("lanes" BETWEEN 1 AND 3);
ALTER TABLE "project" ADD CONSTRAINT "project_cap_positive" CHECK ("cap_usd" > 0);
ALTER TABLE "spec" ADD CONSTRAINT "spec_version_positive" CHECK ("version" >= 1);
ALTER TABLE "requirements_doc" ADD CONSTRAINT "requirements_doc_version_positive" CHECK ("version" >= 1);
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_ordinal_positive" CHECK ("ordinal" >= 1);
ALTER TABLE "module" ADD CONSTRAINT "module_lane_range" CHECK ("lane" BETWEEN 1 AND 3);
ALTER TABLE "module_dependency" ADD CONSTRAINT "module_dependency_no_self" CHECK ("module_id" <> "depends_on_id");
ALTER TABLE "task" ADD CONSTRAINT "task_attempts_nonneg" CHECK ("attempts" >= 0);
ALTER TABLE "run" ADD CONSTRAINT "run_limits_positive" CHECK ("attempt" >= 1 AND "max_turns" > 0 AND "max_seconds" > 0 AND "max_cost_usd" > 0 AND "turns" >= 0);
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_seq_nonneg" CHECK ("seq" >= 0);
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_usd_nonneg" CHECK ("usd" >= 0);
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_tokens_nonneg" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_write_tokens" >= 0);
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_one_source" CHECK (num_nonnulls("run_id", "review_verdict_id") = 1);
ALTER TABLE "review_verdict" ADD CONSTRAINT "review_verdict_round_positive" CHECK ("round" >= 1);
ALTER TABLE "review_finding" ADD CONSTRAINT "review_finding_line_nonneg" CHECK ("line" >= 0);
ALTER TABLE "health_check" ADD CONSTRAINT "health_check_latency_nonneg" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0);
ALTER TABLE "approval" ADD CONSTRAINT "approval_cost_nonneg" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0);
ALTER TABLE "notification" ADD CONSTRAINT "notification_attempts_nonneg" CHECK ("attempts" >= 0);
ALTER TABLE "vault_secret" ADD CONSTRAINT "vault_secret_material" CHECK ("key_version" >= 1 AND octet_length("ciphertext") > 0 AND octet_length("nonce") > 0);
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_cost_nonneg" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0);
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_singleton" CHECK ("singleton");
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_values" CHECK (
  "anthropic_cap_usd" > 0 AND "openai_cap_usd" > 0 AND "default_project_cap_usd" > 0
  AND "probation_minutes" > 0 AND "archive_days" > 0 AND "audit_retention_months" >= 1
  AND "max_lanes" BETWEEN 1 AND 3 AND "default_lanes" BETWEEN 1 AND "max_lanes");

-- ---------- approvals ----------
-- A decided card has a decision time; a purge is approved only with a signed confirmation (gate 5).
ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_has_time" CHECK ("status" = 'pending' OR "decided_at" IS NOT NULL);
ALTER TABLE "approval" ADD CONSTRAINT "approval_purge_confirmed" CHECK ("gate" <> 'purge' OR "status" <> 'approved' OR "confirmation_hash" IS NOT NULL);

-- ---------- at most one approved requirements doc per project (gate 1) ----------
CREATE FUNCTION devos_one_approved_requirements_doc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    PERFORM pg_advisory_xact_lock(hashtext('requirements_doc:' || NEW.project_id::text));
    IF EXISTS (SELECT 1 FROM requirements_doc
               WHERE project_id = NEW.project_id AND status = 'approved' AND id <> NEW.id) THEN
      RAISE EXCEPTION 'project % already has an approved requirements doc', NEW.project_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirements_doc_one_approved BEFORE INSERT OR UPDATE OF status, project_id ON "requirements_doc"
  FOR EACH ROW EXECUTE FUNCTION devos_one_approved_requirements_doc();

-- ---------- global vault secret names are unique (NULL project = global) ----------
CREATE FUNCTION devos_vault_global_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('vault_secret:global:' || NEW.name));
    IF EXISTS (SELECT 1 FROM vault_secret WHERE project_id IS NULL AND name = NEW.name AND id <> NEW.id) THEN
      RAISE EXCEPTION 'global vault secret % already exists', NEW.name USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vault_secret_global_unique BEFORE INSERT OR UPDATE OF name, project_id ON "vault_secret"
  FOR EACH ROW EXECUTE FUNCTION devos_vault_global_unique();

-- ---------- D1 in the database (M1.1-h) ----------
-- Every deploy's commit belongs to its project. A live deploy references a PASS verdict for the
-- same commit.
CREATE FUNCTION devos_deploy_requires_pass() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_verdict verdict;
  v_commit uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "commit" WHERE id = NEW.commit_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'deploy %: commit does not belong to project %', NEW.id, NEW.project_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.environment = 'live' THEN
    IF NEW.review_verdict_id IS NULL THEN
      RAISE EXCEPTION 'D1: live deploy % has no review verdict', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    SELECT verdict, commit_id INTO v_verdict, v_commit FROM review_verdict WHERE id = NEW.review_verdict_id;
    IF v_verdict IS DISTINCT FROM 'pass' THEN
      RAISE EXCEPTION 'D1: live deploy % references a verdict that is not PASS', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_commit IS DISTINCT FROM NEW.commit_id THEN
      RAISE EXCEPTION 'D1: live deploy % references a verdict for a different commit', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deploy_requires_pass BEFORE INSERT OR UPDATE OF environment, commit_id, review_verdict_id, project_id ON "deploy"
  FOR EACH ROW EXECUTE FUNCTION devos_deploy_requires_pass();

-- A verdict is evidence about one SHA: it is never edited once stored, so a deploy's PASS cannot
-- be turned into something else later.
CREATE FUNCTION devos_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER review_verdict_immutable BEFORE UPDATE ON "review_verdict"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();

-- ---------- audit trail is append-only (DV-NFR-06) ----------
-- UPDATE and TRUNCATE are rejected. DELETE is left to the retention job (audit_retention_months).
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION devos_reject_update();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION devos_reject_update();
