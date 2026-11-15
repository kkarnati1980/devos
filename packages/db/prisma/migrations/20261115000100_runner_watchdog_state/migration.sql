-- DEVOS-220 (docs/modules/runner-watchdog.md): the runner watchdog's state, one row (id 1).
-- Additive only (ADR-0011 §10): a new table that older code never reads.

-- CreateTable
CREATE TABLE "runner_watchdog_state" (
    "id" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "runner_watchdog_state_pkey" PRIMARY KEY ("id")
);
