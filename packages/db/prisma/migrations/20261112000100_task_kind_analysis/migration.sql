-- M2.2-d3b1 analyst model pass (docs/modules/M2.2.md, "M2.2-d3b — Behaviour" §1). Additive only (ADR-0011 §10):
-- a new task kind for the intake analysis task a model run is recorded against; the previous release keeps working.

-- AlterEnum
ALTER TYPE "task_kind" ADD VALUE 'analysis';
