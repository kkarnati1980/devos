-- DEVOS-187 (docs/modules/M2.2.md, "Stale-run sweep index"): a partial expression index for the analyst stale-run
-- sweep (DEVOS-171), so its listing reads only open analyst runs instead of scanning the whole run table.
-- Additive only (ADR-0011 §10): a new index, no column or data change; the previous release keeps working.
-- Prisma's schema cannot express a partial or expression index, so it lives here only (see the contract note).
CREATE INDEX "run_open_analyst_started_idx" ON "run" ((COALESCE("started_at", "created_at")))
  WHERE "role" = 'analyst'::"role" AND "status" IN ('queued'::"run_status", 'running'::"run_status");
