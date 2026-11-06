-- M1.6 notifications (docs/modules/M1.6.md). Additive only (ADR-0011 §10): new nullable columns,
-- new indexes and checks that hold for every existing row, so the previous release keeps working.

-- The notice a channel row delivers: one row per channel share the same notice_id.
ALTER TABLE "notification" ADD COLUMN "notice_id" UUID;
ALTER TABLE "notification" ADD COLUMN "kind" TEXT;
ALTER TABLE "notification" ADD COLUMN "title" TEXT;
ALTER TABLE "notification" ADD COLUMN "body" TEXT;
ALTER TABLE "notification" ADD COLUMN "reasons" JSONB;
ALTER TABLE "notification" ADD COLUMN "project_id" UUID;

ALTER TABLE "notification" ADD CONSTRAINT "notification_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A notice row carries a known kind, a title, a body and an array of reasons (all NOT NULL: a CHECK
-- that evaluates to UNKNOWN passes, PR18-r1); limits match the API's validation.
ALTER TABLE "notification" ADD CONSTRAINT "notification_notice_shape" CHECK (
  "notice_id" IS NULL OR (
    "kind" IS NOT NULL AND "kind" IN ('test', 'standard_selection', 'approval', 'info')
    AND "title" IS NOT NULL AND char_length("title") BETWEEN 1 AND 120
    AND "body" IS NOT NULL AND char_length("body") <= 2000
    AND "reasons" IS NOT NULL AND jsonb_typeof("reasons") = 'array'
  )
) NOT VALID;
-- The stored delivery error is a fixed code, never a transport message.
ALTER TABLE "notification" ADD CONSTRAINT "notification_error_code" CHECK ("error" IS NULL OR "error" ~ '^[a-z0-9-]{1,64}$') NOT VALID;

CREATE UNIQUE INDEX "notification_notice_id_channel_key" ON "notification"("notice_id", "channel");
CREATE INDEX "notification_channel_created_at_idx" ON "notification"("channel", "created_at");
CREATE INDEX "notification_project_id_idx" ON "notification"("project_id");
