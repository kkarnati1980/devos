-- DEVOS-215 (CR-b2b, docs/modules/ADR-0012.md rules 6–10): batched mid-build questions. Additive only (ADR-0011 §10):
-- two new tables, no change to existing ones.

-- CreateTable
CREATE TABLE "queued_question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "default" TEXT NOT NULL,
    "blocks" UUID[],
    "queued_at" TIMESTAMPTZ(6) NOT NULL,
    "batch_id" UUID,

    CONSTRAINT "queued_question_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "queued_question_text_valid" CHECK (char_length("text") BETWEEN 1 AND 1000),
    CONSTRAINT "queued_question_default_valid" CHECK (char_length("default") BETWEEN 1 AND 200),
    CONSTRAINT "queued_question_blocks_valid" CHECK (cardinality("blocks") <= 50)
);

-- CreateTable
CREATE TABLE "card_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "ist_day" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "card_id" UUID,
    "applied_at" TIMESTAMPTZ(6),
    "handed_off_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_batch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "card_batch_state_valid" CHECK ("state" IN ('raising', 'raised', 'refused')),
    CONSTRAINT "card_batch_ist_day_valid" CHECK ("ist_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "card_batch_raised_has_card" CHECK ("state" <> 'raised' OR "card_id" IS NOT NULL)
);

-- CreateIndex
CREATE INDEX "queued_question_project_id_batch_id_queued_at_idx" ON "queued_question"("project_id", "batch_id", "queued_at");

-- CreateIndex
CREATE INDEX "queued_question_batch_id_queued_at_id_idx" ON "queued_question"("batch_id", "queued_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "card_batch_project_id_ist_day_key" ON "card_batch"("project_id", "ist_day");

-- CreateIndex
CREATE INDEX "card_batch_state_applied_at_idx" ON "card_batch"("state", "applied_at");

-- AddForeignKey
ALTER TABLE "queued_question" ADD CONSTRAINT "queued_question_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queued_question" ADD CONSTRAINT "queued_question_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "card_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_batch" ADD CONSTRAINT "card_batch_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_batch" ADD CONSTRAINT "card_batch_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
