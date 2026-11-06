-- M1.5 (docs/modules/M1.5.md, PS amendment / ADR-0011 S5): a telemetry tag per turn, e.g.
-- `standard_selection` for selection-loop tokens. Additive and nullable: backward-compatible.
ALTER TABLE "run_telemetry" ADD COLUMN "tag" TEXT;
ALTER TABLE "run_telemetry" ADD CONSTRAINT "run_telemetry_tag_format" CHECK ("tag" IS NULL OR "tag" ~ '^[a-z][a-z0-9_]{0,39}$');
CREATE INDEX "run_telemetry_tag_idx" ON "run_telemetry"("tag");
