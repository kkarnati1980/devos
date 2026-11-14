-- DEVOS-198 (CR-a2, docs/modules/ADR-0012.md "CR-a2 design"): continuous-run mode, the intake pre-flight state,
-- the pre-flight list per requirements doc, and the project decision log.
-- Additive only (ADR-0011 §10). Existing projects keep running: they are backfilled continuous_run = false and
-- preflight_state = 'approved' by the first default; the column default then changes, so rows inserted later (by
-- old or new code) get continuous_run = true and preflight_state = 'pending'.

-- AlterTable
ALTER TABLE "project" ADD COLUMN "continuous_run" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project" ALTER COLUMN "continuous_run" SET DEFAULT true;
ALTER TABLE "project" ADD COLUMN "preflight_state" TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE "project" ALTER COLUMN "preflight_state" SET DEFAULT 'pending';
ALTER TABLE "project" ADD CONSTRAINT "project_preflight_state_check" CHECK ("preflight_state" IN ('pending', 'approved', 'rejected'));

-- AlterTable
ALTER TABLE "requirements_doc" ADD COLUMN "preflight" JSONB;

-- CreateTable
CREATE TABLE "project_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "item_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "approval_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_decision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_decision_source_check" CHECK ("source" IN ('kk', 'default', 'default-provisional'))
);

-- CreateIndex
CREATE INDEX "project_decision_project_id_item_id_created_at_idx" ON "project_decision"("project_id", "item_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_decision_approval_id_item_id_key" ON "project_decision"("approval_id", "item_id");

-- AddForeignKey
ALTER TABLE "project_decision" ADD CONSTRAINT "project_decision_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_decision" ADD CONSTRAINT "project_decision_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
