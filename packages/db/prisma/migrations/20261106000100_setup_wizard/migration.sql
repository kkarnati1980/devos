-- M1.4 setup wizard (docs/modules/M1.4.md). Additive only (ADR-0011 §10): new nullable or defaulted
-- columns, so the previous release keeps working against this schema.

-- The last 4 characters of a secret, the only part of its value the API ever shows.
ALTER TABLE "vault_secret" ADD COLUMN "hint" TEXT;
ALTER TABLE "vault_secret" ADD CONSTRAINT "vault_secret_hint_len" CHECK ("hint" IS NULL OR char_length("hint") = 4);

-- Deadlock attempts (rules.md: Sonnet, Sonnet, Opus = 3) and when KK confirmed the three caps.
ALTER TABLE "app_settings" ADD COLUMN "deadlock_attempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "app_settings" ADD COLUMN "caps_confirmed_at" TIMESTAMPTZ(6);
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_deadlock_attempts" CHECK ("deadlock_attempts" BETWEEN 1 AND 5);
