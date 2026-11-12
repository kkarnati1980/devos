-- M2.4-a provisioning step journal (docs/modules/M2.4.md, decision 4). Additive only (ADR-0011 §10):
-- a new enum and a new table, so the previous release keeps working.

-- CreateEnum
CREATE TYPE "provision_step_status" AS ENUM ('pending', 'done', 'failed');

-- CreateTable
CREATE TABLE "provision_step" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "provider" "resource_provider" NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "provision_step_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "external_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provision_step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provision_step_project_id_key_key" ON "provision_step"("project_id", "key");

-- AddForeignKey
ALTER TABLE "provision_step" ADD CONSTRAINT "provision_step_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks (not part of the Prisma schema, so not seen by the drift check): a done step has an external id,
-- attempts never go negative, and the stored error is a short code-prefixed line, never a transport dump.
ALTER TABLE "provision_step" ADD CONSTRAINT "provision_step_done_has_external_id" CHECK ("status" <> 'done' OR "external_id" IS NOT NULL);
ALTER TABLE "provision_step" ADD CONSTRAINT "provision_step_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "provision_step" ADD CONSTRAINT "provision_step_last_error_short" CHECK ("last_error" IS NULL OR char_length("last_error") <= 300);
