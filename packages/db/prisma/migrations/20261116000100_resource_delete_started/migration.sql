-- DEVOS-235 (Codex PR160-r1): a purge records when it began a row's provider delete, so a later run can tell its own
-- earlier delete from a wrong-team token. Additive and nullable (ADR-0011: backward-compatible migrations).
ALTER TABLE "resource" ADD COLUMN "delete_started_at" TIMESTAMPTZ(6);
