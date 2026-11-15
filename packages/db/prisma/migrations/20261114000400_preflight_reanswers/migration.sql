-- DEVOS-204 (docs/modules/ADR-0012.md "DEVOS-204"): a later KK comment re-answers a pre-flight item (ADR-0012 rule 3).
-- Additive only (ADR-0011 §10): two nullable columns, one unique index, one foreign key. Old code never sets
-- comment_id, so its rows keep the (approval_id, item_id) rule; a re-answer row has approval_id NULL and is unique
-- on (comment_id, item_id).

-- AlterTable
ALTER TABLE "requirements_doc" ADD COLUMN "answers_synced_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "project_decision" ADD COLUMN "comment_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "project_decision_comment_id_item_id_key" ON "project_decision"("comment_id", "item_id");

-- AddForeignKey
ALTER TABLE "project_decision" ADD CONSTRAINT "project_decision_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "approval_comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
