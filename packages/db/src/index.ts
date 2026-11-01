// @devos/db — the one way DevOS services open the database (M1.1 interface).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";

/**
 * Create a Prisma client over node-postgres for the given connection string.
 * The URL must come from the environment or the server vault; it is never hard-coded.
 */
export function createDb(databaseUrl: string): PrismaClient {
  if (!databaseUrl) throw new Error("createDb: databaseUrl is required");
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
