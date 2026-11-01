// Prisma CLI configuration (M1.1-b). The database URL comes only from the environment; it is
// never in the schema or the repo. `prisma generate` runs without one (CI typecheck);
// migrate commands need DATABASE_URL (and SHADOW_DATABASE_URL for `migrate diff`/`dev`).
import { defineConfig } from "prisma/config";

const url = process.env.DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(url ? { datasource: { url, ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) } } : {}),
});
