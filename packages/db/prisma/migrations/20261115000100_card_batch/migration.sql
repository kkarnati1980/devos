-- DEVOS-215 (CR-b2b, docs/modules/ADR-0012.md "CR-b2b"): batched mid-build questions (ADR-0012 rules 6–10).
-- Additive only (ADR-0011 §10): two new tables, nothing existing changes. Old code never reads them.

-- CreateTable
CREATE TABLE "queued_question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "default_answer" TEXT NOT NULL,
    "blocks" UUID[] DEFAULT ARRAY[]::UUID[],
    "queued_at" TIMESTAMPTZ(6) NOT NULL,
    "batch_id" UUID,

    CONSTRAINT "queued_question_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "queued_question_values_valid" CHECK (
        char_length("text") BETWEEN 1 AND 1000
        AND char_length("default_answer") BETWEEN 1 AND 200
        AND char_length("source") BETWEEN 1 AND 100
        AND "blocks" IS NOT NULL
        AND cardinality("blocks") <= 50
    )
);

-- CreateTable
CREATE TABLE "card_batch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "ist_day" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'raising',
    "card_id" UUID,
    "applied_at" TIMESTAMPTZ(6),
    "handed_off_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_batch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "card_batch_ist_day_valid" CHECK ("ist_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT "card_batch_state_valid" CHECK (
        ("state" = 'raising' AND "card_id" IS NULL)
        OR ("state" = 'raised' AND "card_id" IS NOT NULL)
        OR ("state" = 'refused' AND "card_id" IS NULL)
    ),
    CONSTRAINT "card_batch_steps_valid" CHECK (
        ("applied_at" IS NULL OR "state" = 'raised')
        AND ("settled_at" IS NULL OR "applied_at" IS NOT NULL)
        AND ("handed_off_at" IS NULL OR "state" = 'refused')
    )
);

-- CreateIndex
CREATE INDEX "queued_question_project_id_batch_id_idx" ON "queued_question"("project_id", "batch_id");

-- CreateIndex
CREATE INDEX "queued_question_batch_id_queued_at_idx" ON "queued_question"("batch_id", "queued_at");

-- CreateIndex
CREATE INDEX "card_batch_state_settled_at_idx" ON "card_batch"("state", "settled_at");

-- CreateIndex
CREATE INDEX "card_batch_card_id_idx" ON "card_batch"("card_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_batch_project_id_ist_day_key" ON "card_batch"("project_id", "ist_day");

-- AddForeignKey
ALTER TABLE "queued_question" ADD CONSTRAINT "queued_question_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queued_question" ADD CONSTRAINT "queued_question_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "card_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_batch" ADD CONSTRAINT "card_batch_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_batch" ADD CONSTRAINT "card_batch_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Codex PR140-r2 (rule 8): at most one card per batch, ever, enforced atomically with the card's insert. M2.3's raise
-- dedupes only a pending twin; a second `batch:<id>` card after the first was decided now fails its whole raise
-- transaction (no card, no blocker), and the next flush's lookup by target records the existing card. Additive only:
-- a partial unique index on the new `batch:` targets, which no earlier release writes. Prisma's schema cannot express
-- a partial index, so it lives here only (as `run_open_analyst_started_idx`).
CREATE UNIQUE INDEX "approval_batch_card_once" ON "approval" ("target") WHERE "gate" = 'decision'::"gate" AND "target" LIKE 'batch:%';
