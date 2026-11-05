-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "project_stage" AS ENUM ('intake', 'provisioning', 'building', 'preview', 'live', 'archived', 'purged');

-- CreateEnum
CREATE TYPE "spec_format" AS ENUM ('docx', 'pdf', 'md', 'html', 'paste');

-- CreateEnum
CREATE TYPE "requirements_doc_status" AS ENUM ('draft', 'approved', 'superseded');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('must', 'should', 'could');

-- CreateEnum
CREATE TYPE "module_status" AS ENUM ('planned', 'ready', 'in_progress', 'in_review', 'merged', 'deadlocked');

-- CreateEnum
CREATE TYPE "task_kind" AS ENUM ('build', 'test', 'review', 'fix', 'maintenance', 'human');

-- CreateEnum
CREATE TYPE "assignee" AS ENUM ('agent', 'kk', 'engineer');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('blocked', 'ready', 'running', 'done', 'failed', 'deadlocked');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('chief', 'analyst', 'architect', 'builder', 'tester', 'reviewer', 'release', 'maintainer');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'limit_hit', 'cancelled');

-- CreateEnum
CREATE TYPE "provider" AS ENUM ('anthropic', 'openai');

-- CreateEnum
CREATE TYPE "check_kind" AS ENUM ('build', 'lint', 'typecheck', 'unit', 'acceptance', 'smoke');

-- CreateEnum
CREATE TYPE "reviewer" AS ENUM ('codex', 'opus_tiebreak');

-- CreateEnum
CREATE TYPE "verdict" AS ENUM ('pass', 'changes_requested');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "environment" AS ENUM ('preview', 'live');

-- CreateEnum
CREATE TYPE "deploy_status" AS ENUM ('pending', 'deploying', 'probation', 'succeeded', 'failed', 'rolled_back');

-- CreateEnum
CREATE TYPE "gate" AS ENUM ('requirements', 'decision', 'first_launch', 'destructive_or_spend', 'purge');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "resource_provider" AS ENUM ('github', 'coolify', 'cloudflare', 'r2', 'vault', 'backup_schedule');

-- CreateEnum
CREATE TYPE "resource_status" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "channel_kind" AS ENUM ('dashboard', 'mybrain', 'email');

-- CreateEnum
CREATE TYPE "memory_type" AS ENUM ('decision', 'observation', 'checkpoint', 'evidence');

-- CreateEnum
CREATE TYPE "actor" AS ENUM ('agent', 'kk', 'system');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "report_kind" AS ENUM ('morning', 'weekly');

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "project_stage" NOT NULL DEFAULT 'intake',
    "paused_at" TIMESTAMPTZ(6),
    "cap_usd" DECIMAL(12,6) NOT NULL DEFAULT 15,
    "lanes" INTEGER NOT NULL DEFAULT 2,
    "repo_url" TEXT,
    "imported_repo" BOOLEAN NOT NULL DEFAULT false,
    "preview_url" TEXT,
    "live_url" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source_format" "spec_format" NOT NULL,
    "original_name" TEXT,
    "file_sha256" TEXT,
    "storage_path" TEXT,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirements_doc" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "repo_path" TEXT NOT NULL,
    "commit_sha" TEXT,
    "status" "requirements_doc_status" NOT NULL DEFAULT 'draft',
    "approval_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "requirements_doc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "priority" "priority" NOT NULL,
    "acceptance" TEXT NOT NULL,
    "milestone_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "gate_name" TEXT NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "gate_approval_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "milestone_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lane" INTEGER NOT NULL,
    "contract_path" TEXT NOT NULL,
    "status" "module_status" NOT NULL DEFAULT 'planned',
    "merged_sha" TEXT,
    "linear_issue" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_dependency" (
    "module_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,

    CONSTRAINT "module_dependency_pkey" PRIMARY KEY ("module_id","depends_on_id")
);

-- CreateTable
CREATE TABLE "module_requirement" (
    "module_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,

    CONSTRAINT "module_requirement_pkey" PRIMARY KEY ("module_id","requirement_id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "module_id" UUID,
    "kind" "task_kind" NOT NULL,
    "assignee" "assignee" NOT NULL DEFAULT 'agent',
    "title" TEXT NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'ready',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "linear_issue" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_requirement" (
    "task_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,

    CONSTRAINT "task_requirement_pkey" PRIMARY KEY ("task_id","requirement_id")
);

-- CreateTable
CREATE TABLE "task_blocker" (
    "task_id" UUID NOT NULL,
    "approval_id" UUID NOT NULL,

    CONSTRAINT "task_blocker_pkey" PRIMARY KEY ("task_id","approval_id")
);

-- CreateTable
CREATE TABLE "run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "role" "role" NOT NULL,
    "model" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "max_turns" INTEGER NOT NULL,
    "max_seconds" INTEGER NOT NULL,
    "max_cost_usd" DECIMAL(12,6) NOT NULL,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "start_sha" TEXT,
    "end_sha" TEXT,
    "branch" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkpoint" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "run_id" UUID,
    "review_verdict_id" UUID,
    "provider" "provider" NOT NULL,
    "model" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "usd" DECIMAL(12,6) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "sha" TEXT NOT NULL,
    "branch" TEXT,
    "module_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "commit_id" UUID NOT NULL,
    "check" "check_kind" NOT NULL,
    "requirement_id" UUID,
    "command" TEXT NOT NULL,
    "exit_code" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "output_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_verdict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "commit_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "reviewer" "reviewer" NOT NULL,
    "verdict" "verdict" NOT NULL,
    "summary" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_verdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_finding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_verdict_id" UUID NOT NULL,
    "severity" "severity" NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "evidence" TEXT NOT NULL,
    "consequence" TEXT NOT NULL,
    "follow_up_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deploy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "commit_id" UUID NOT NULL,
    "environment" "environment" NOT NULL,
    "status" "deploy_status" NOT NULL DEFAULT 'pending',
    "review_verdict_id" UUID,
    "approval_id" UUID,
    "coolify_deployment" TEXT,
    "rolled_back_to_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deploy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_check" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "environment" "environment" NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "gate" "gate" NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cost_usd" DECIMAL(12,6),
    "consequence" TEXT,
    "status" "approval_status" NOT NULL DEFAULT 'pending',
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" TEXT,
    "confirmation_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_comment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approval_id" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "provider" "resource_provider" NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "resource_status" NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "anthropic_cap_usd" DECIMAL(12,6) NOT NULL DEFAULT 15,
    "openai_cap_usd" DECIMAL(12,6) NOT NULL DEFAULT 15,
    "default_project_cap_usd" DECIMAL(12,6) NOT NULL DEFAULT 15,
    "probation_minutes" INTEGER NOT NULL DEFAULT 15,
    "archive_days" INTEGER NOT NULL DEFAULT 30,
    "default_lanes" INTEGER NOT NULL DEFAULT 2,
    "max_lanes" INTEGER NOT NULL DEFAULT 3,
    "report_time" TEXT NOT NULL DEFAULT '08:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "audit_retention_months" INTEGER NOT NULL DEFAULT 12,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_model" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" "role" NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "channel_kind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "target" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_secret" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "name" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vault_secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "task_id" UUID,
    "type" "memory_type" NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" "actor" NOT NULL,
    "role" "role",
    "project_id" UUID,
    "sha" TEXT,
    "cost_usd" DECIMAL(12,6),
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approval_id" UUID,
    "channel" "channel_kind" NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "report_kind" NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_slug_key" ON "project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "spec_project_id_version_key" ON "spec"("project_id", "version");

-- CreateIndex
CREATE INDEX "requirements_doc_approval_id_idx" ON "requirements_doc"("approval_id");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_doc_project_id_version_key" ON "requirements_doc"("project_id", "version");

-- CreateIndex
CREATE INDEX "requirement_milestone_id_idx" ON "requirement"("milestone_id");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_project_id_key_key" ON "requirement"("project_id", "key");

-- CreateIndex
CREATE INDEX "milestone_gate_approval_id_idx" ON "milestone"("gate_approval_id");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_project_id_ordinal_key" ON "milestone"("project_id", "ordinal");

-- CreateIndex
CREATE INDEX "module_milestone_id_idx" ON "module"("milestone_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_project_id_key_key" ON "module"("project_id", "key");

-- CreateIndex
CREATE INDEX "module_dependency_depends_on_id_idx" ON "module_dependency"("depends_on_id");

-- CreateIndex
CREATE INDEX "module_requirement_requirement_id_idx" ON "module_requirement"("requirement_id");

-- CreateIndex
CREATE INDEX "task_project_id_status_idx" ON "task"("project_id", "status");

-- CreateIndex
CREATE INDEX "task_module_id_idx" ON "task"("module_id");

-- CreateIndex
CREATE INDEX "task_requirement_requirement_id_idx" ON "task_requirement"("requirement_id");

-- CreateIndex
CREATE INDEX "task_blocker_approval_id_idx" ON "task_blocker"("approval_id");

-- CreateIndex
CREATE INDEX "run_task_id_idx" ON "run"("task_id");

-- CreateIndex
CREATE INDEX "run_project_id_status_idx" ON "run"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checkpoint_run_id_seq_key" ON "checkpoint"("run_id", "seq");

-- CreateIndex
CREATE INDEX "cost_entry_project_id_occurred_at_idx" ON "cost_entry"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cost_entry_run_id_idx" ON "cost_entry"("run_id");

-- CreateIndex
CREATE INDEX "cost_entry_review_verdict_id_idx" ON "cost_entry"("review_verdict_id");

-- CreateIndex
CREATE INDEX "commit_module_id_idx" ON "commit"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "commit_project_id_sha_key" ON "commit"("project_id", "sha");

-- CreateIndex
CREATE INDEX "test_evidence_commit_id_idx" ON "test_evidence"("commit_id");

-- CreateIndex
CREATE INDEX "test_evidence_requirement_id_idx" ON "test_evidence"("requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_verdict_commit_id_round_key" ON "review_verdict"("commit_id", "round");

-- CreateIndex
CREATE INDEX "review_finding_review_verdict_id_idx" ON "review_finding"("review_verdict_id");

-- CreateIndex
CREATE INDEX "review_finding_follow_up_task_id_idx" ON "review_finding"("follow_up_task_id");

-- CreateIndex
CREATE INDEX "deploy_project_id_environment_created_at_idx" ON "deploy"("project_id", "environment", "created_at");

-- CreateIndex
CREATE INDEX "deploy_commit_id_idx" ON "deploy"("commit_id");

-- CreateIndex
CREATE INDEX "deploy_review_verdict_id_idx" ON "deploy"("review_verdict_id");

-- CreateIndex
CREATE INDEX "deploy_approval_id_idx" ON "deploy"("approval_id");

-- CreateIndex
CREATE INDEX "deploy_rolled_back_to_id_idx" ON "deploy"("rolled_back_to_id");

-- CreateIndex
CREATE INDEX "health_check_project_id_environment_checked_at_idx" ON "health_check"("project_id", "environment", "checked_at");

-- CreateIndex
CREATE INDEX "approval_project_id_status_idx" ON "approval"("project_id", "status");

-- CreateIndex
CREATE INDEX "approval_status_created_at_idx" ON "approval"("status", "created_at");

-- CreateIndex
CREATE INDEX "approval_comment_approval_id_idx" ON "approval_comment"("approval_id");

-- CreateIndex
CREATE INDEX "resource_project_id_status_idx" ON "resource"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "resource_provider_kind_external_id_key" ON "resource"("provider", "kind", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_singleton_key" ON "app_settings"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "role_model_role_key" ON "role_model"("role");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channel_kind_key" ON "notification_channel"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "vault_secret_project_id_name_key" ON "vault_secret"("project_id", "name");

-- CreateIndex
CREATE INDEX "memory_item_project_id_type_idx" ON "memory_item"("project_id", "type");

-- CreateIndex
CREATE INDEX "memory_item_task_id_idx" ON "memory_item"("task_id");

-- CreateIndex
CREATE INDEX "audit_event_project_id_occurred_at_idx" ON "audit_event"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_event_occurred_at_idx" ON "audit_event"("occurred_at");

-- CreateIndex
CREATE INDEX "notification_approval_id_idx" ON "notification"("approval_id");

-- CreateIndex
CREATE INDEX "notification_status_created_at_idx" ON "notification"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "report_kind_period_start_key" ON "report"("kind", "period_start");

-- AddForeignKey
ALTER TABLE "spec" ADD CONSTRAINT "spec_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements_doc" ADD CONSTRAINT "requirements_doc_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements_doc" ADD CONSTRAINT "requirements_doc_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone" ADD CONSTRAINT "milestone_gate_approval_id_fkey" FOREIGN KEY ("gate_approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module" ADD CONSTRAINT "module_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module" ADD CONSTRAINT "module_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_dependency" ADD CONSTRAINT "module_dependency_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_dependency" ADD CONSTRAINT "module_dependency_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_requirement" ADD CONSTRAINT "module_requirement_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "module_requirement" ADD CONSTRAINT "module_requirement_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requirement" ADD CONSTRAINT "task_requirement_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requirement" ADD CONSTRAINT "task_requirement_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_blocker" ADD CONSTRAINT "task_blocker_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_blocker" ADD CONSTRAINT "task_blocker_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkpoint" ADD CONSTRAINT "checkpoint_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entry" ADD CONSTRAINT "cost_entry_review_verdict_id_fkey" FOREIGN KEY ("review_verdict_id") REFERENCES "review_verdict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit" ADD CONSTRAINT "commit_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit" ADD CONSTRAINT "commit_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_evidence" ADD CONSTRAINT "test_evidence_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_evidence" ADD CONSTRAINT "test_evidence_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_verdict" ADD CONSTRAINT "review_verdict_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_finding" ADD CONSTRAINT "review_finding_review_verdict_id_fkey" FOREIGN KEY ("review_verdict_id") REFERENCES "review_verdict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_finding" ADD CONSTRAINT "review_finding_follow_up_task_id_fkey" FOREIGN KEY ("follow_up_task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_review_verdict_id_fkey" FOREIGN KEY ("review_verdict_id") REFERENCES "review_verdict"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_rolled_back_to_id_fkey" FOREIGN KEY ("rolled_back_to_id") REFERENCES "deploy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_check" ADD CONSTRAINT "health_check_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_comment" ADD CONSTRAINT "approval_comment_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_secret" ADD CONSTRAINT "vault_secret_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

