-- CreateEnum
CREATE TYPE "provenance" AS ENUM ('kk_approved', 'system_observation', 'tool_result', 'agent_output', 'user_claim', 'unknown');

-- CreateEnum
CREATE TYPE "policy_mode" AS ENUM ('observe', 'enforce');

-- CreateEnum
CREATE TYPE "policy_effect" AS ENUM ('allow', 'deny', 'require_approval');

-- CreateEnum
CREATE TYPE "budget_status" AS ENUM ('reserved', 'reconciled', 'released');

-- CreateEnum
CREATE TYPE "run_event_type" AS ENUM ('status', 'text', 'tool_call', 'tool_result', 'artifact', 'usage', 'error', 'done');

-- CreateEnum
CREATE TYPE "run_error_type" AS ENUM ('provider_error', 'rate_limited', 'policy_denied', 'budget_exceeded', 'timeout', 'cancelled', 'missing_input', 'sandbox_error', 'internal');

-- CreateEnum
CREATE TYPE "artifact_kind" AS ENUM ('log', 'output', 'file');

-- CreateEnum
CREATE TYPE "mechanism" AS ENUM ('archive', 'fusion', 'log_reader', 'ptc');

-- AlterTable
ALTER TABLE "memory_item" ADD COLUMN     "provenance" "provenance" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "source_ref" TEXT;

-- AlterTable
ALTER TABLE "test_evidence" ADD COLUMN     "expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "provenance" "provenance" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "source_ref" TEXT;

-- CreateTable
CREATE TABLE "policy_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "actions" TEXT[],
    "resources" TEXT[],
    "principals" TEXT[],
    "roles" "role"[],
    "environments" TEXT[],
    "effect" "policy_effect" NOT NULL,
    "constraints" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "mode" "policy_mode" NOT NULL DEFAULT 'observe',
    "bundle_hash" TEXT,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policy_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chain" TEXT NOT NULL DEFAULT 'main',
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" UUID,
    "run_id" UUID,
    "identity" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "outcome" "policy_effect" NOT NULL,
    "enforced_outcome" "policy_effect" NOT NULL,
    "matched_rule_ids" TEXT[],
    "approval_grant_id" UUID,
    "bundle_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "prev_hash" TEXT,
    "hmac" TEXT NOT NULL,

    CONSTRAINT "policy_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_grant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approval_id" UUID,
    "scope_action" TEXT NOT NULL,
    "scope_resource" TEXT,
    "project_id" UUID,
    "sha" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "approval_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_envelope" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_id" UUID,
    "run_id" UUID,
    "tools" TEXT[],
    "read_paths" TEXT[],
    "write_paths" TEXT[],
    "network" BOOLEAN NOT NULL DEFAULT false,
    "network_allow_list" TEXT,
    "max_cost_usd" DECIMAL(12,6) NOT NULL,
    "max_tokens" INTEGER NOT NULL,
    "max_concurrency" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "run_id" UUID,
    "provider" "provider" NOT NULL,
    "reserved_usd" DECIMAL(12,6) NOT NULL,
    "reserved_tokens" INTEGER NOT NULL,
    "actual_usd" DECIMAL(12,6),
    "actual_tokens" INTEGER,
    "status" "budget_status" NOT NULL DEFAULT 'reserved',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "run_event_type" NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "run_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_error" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "type" "run_error_type" NOT NULL,
    "message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL,
    "counts_as_attempt" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_error_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_telemetry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "turn" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL,
    "cache_write_tokens" INTEGER NOT NULL,
    "context_tokens" INTEGER NOT NULL,
    "tool_name" TEXT,
    "tool_result_bytes" INTEGER,
    "repeated_call" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "kind" "artifact_kind" NOT NULL,
    "bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "excerpt_head" TEXT,
    "excerpt_tail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "log_receipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "artifact_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "exit_code" INTEGER NOT NULL,
    "quotes" TEXT[],
    "verified" BOOLEAN NOT NULL,
    "fallback_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mechanism_flag" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" "role" NOT NULL,
    "mechanism" "mechanism" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "changed_by" TEXT NOT NULL,
    "reason" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mechanism_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_metric" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" "role" NOT NULL,
    "window_size" INTEGER NOT NULL DEFAULT 20,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "codex_first_pass_rate" DECIMAL(5,4) NOT NULL,
    "ci_first_green_rate" DECIMAL(5,4) NOT NULL,
    "opus_escalation_rate" DECIMAL(5,4) NOT NULL,
    "deadlocks" INTEGER NOT NULL,
    "rollbacks" INTEGER NOT NULL,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_metric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_name_version_key" ON "policy_rule"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "policy_state_singleton_key" ON "policy_state"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "policy_decision_hash_key" ON "policy_decision"("hash");

-- CreateIndex
CREATE INDEX "policy_decision_project_id_ts_idx" ON "policy_decision"("project_id", "ts");

-- CreateIndex
CREATE INDEX "policy_decision_run_id_idx" ON "policy_decision"("run_id");

-- CreateIndex
CREATE INDEX "policy_decision_approval_grant_id_idx" ON "policy_decision"("approval_grant_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_decision_chain_seq_key" ON "policy_decision"("chain", "seq");

-- CreateIndex
CREATE INDEX "approval_grant_approval_id_idx" ON "approval_grant"("approval_id");

-- CreateIndex
CREATE INDEX "approval_grant_project_id_expires_at_idx" ON "approval_grant"("project_id", "expires_at");

-- CreateIndex
CREATE INDEX "capability_envelope_parent_id_idx" ON "capability_envelope"("parent_id");

-- CreateIndex
CREATE INDEX "capability_envelope_run_id_idx" ON "capability_envelope"("run_id");

-- CreateIndex
CREATE INDEX "budget_reservation_project_id_status_idx" ON "budget_reservation"("project_id", "status");

-- CreateIndex
CREATE INDEX "budget_reservation_run_id_idx" ON "budget_reservation"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_event_run_id_seq_key" ON "run_event"("run_id", "seq");

-- CreateIndex
CREATE INDEX "run_error_run_id_idx" ON "run_error"("run_id");

-- CreateIndex
CREATE INDEX "run_telemetry_run_id_turn_idx" ON "run_telemetry"("run_id", "turn");

-- CreateIndex
CREATE INDEX "artifact_run_id_idx" ON "artifact"("run_id");

-- CreateIndex
CREATE INDEX "log_receipt_artifact_id_idx" ON "log_receipt"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "mechanism_flag_role_mechanism_key" ON "mechanism_flag"("role", "mechanism");

-- CreateIndex
CREATE INDEX "guard_metric_role_window_end_idx" ON "guard_metric"("role", "window_end");

-- AddForeignKey
ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_approval_grant_id_fkey" FOREIGN KEY ("approval_grant_id") REFERENCES "approval_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_grant" ADD CONSTRAINT "approval_grant_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_envelope" ADD CONSTRAINT "capability_envelope_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "capability_envelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_envelope" ADD CONSTRAINT "capability_envelope_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_error" ADD CONSTRAINT "run_error_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_telemetry" ADD CONSTRAINT "run_telemetry_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "log_receipt" ADD CONSTRAINT "log_receipt_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

