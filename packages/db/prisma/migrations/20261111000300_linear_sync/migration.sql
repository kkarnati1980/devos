-- M2.6 Linear sync (docs/modules/M2.6.md). Additive only (ADR-0011): one new enum value, so the previous
-- release keeps working. The Linear project and milestone ids are stored as resource rows
-- (provider 'linear', kind 'project' | 'milestone'); module and task issues use the existing linear_issue columns.
ALTER TYPE "resource_provider" ADD VALUE IF NOT EXISTS 'linear';
