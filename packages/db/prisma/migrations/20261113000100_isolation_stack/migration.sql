-- S4-a2a per-stack isolation records (docs/modules/S4.md, "S4-a2 split"). Additive only (ADR-0011 §10):
-- a new table, so the previous release keeps working.

-- CreateTable
CREATE TABLE "isolation_stack" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "network" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "isolation_stack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "isolation_stack_project_id_env_key" ON "isolation_stack"("project_id", "env");

-- CreateIndex
CREATE UNIQUE INDEX "isolation_stack_idx_key" ON "isolation_stack"("idx");

-- CreateIndex
CREATE UNIQUE INDEX "isolation_stack_subnet_key" ON "isolation_stack"("subnet");

-- CreateIndex
CREATE UNIQUE INDEX "isolation_stack_network_key" ON "isolation_stack"("network");

-- AddForeignKey
ALTER TABLE "isolation_stack" ADD CONSTRAINT "isolation_stack_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks (not part of the Prisma schema, so not seen by the drift check): the same rules as packages/isolation
-- (network.ts): env preview|live, index 0–1023 (pool 10.208.0.0/14 in /24 blocks), a valid slug, and a subnet
-- inside the pool. The state document refuses anything else, so the table never holds a row it would refuse.
ALTER TABLE "isolation_stack" ADD CONSTRAINT "isolation_stack_env_valid" CHECK ("env" IN ('preview', 'live'));
ALTER TABLE "isolation_stack" ADD CONSTRAINT "isolation_stack_idx_range" CHECK ("idx" BETWEEN 0 AND 1023);
ALTER TABLE "isolation_stack" ADD CONSTRAINT "isolation_stack_slug_valid" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$');
ALTER TABLE "isolation_stack" ADD CONSTRAINT "isolation_stack_subnet_in_pool" CHECK ("subnet"::cidr <<= '10.208.0.0/14'::cidr);
