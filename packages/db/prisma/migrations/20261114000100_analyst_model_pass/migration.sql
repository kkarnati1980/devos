-- DEVOS-176 (docs/modules/M2.2.md, "M2.2-d3b2 — Behaviour" §7): the analyst model pass switch in app settings.
-- Additive only (ADR-0011 §10): a new column with a default, so the previous release keeps working. Default off.

-- AlterTable
ALTER TABLE "app_settings" ADD COLUMN "analyst_model_pass" BOOLEAN NOT NULL DEFAULT false;
