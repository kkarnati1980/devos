-- DEVOS-220 (docs/modules/runner-watchdog.md): the runner watchdog's state, one row (name 'runner-watchdog').
-- Additive only (ADR-0011 §10): a new table that older code never reads.

-- CreateTable
CREATE TABLE "runner_watchdog_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "runner_watchdog_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runner_watchdog_state_name_key" ON "runner_watchdog_state"("name");
