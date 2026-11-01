// M1.1 AT9: the package's createDb() connects through PrismaPg and round-trips a row.
// Imports the built package (dist/), so CI runs `pnpm run build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../dist/index.js";
import { url } from "./helpers.mjs";

test("AT9 createDb inserts a project and reads it back", async () => {
  const db = createDb(url());
  const slug = `client-test-${process.pid}`;
  try {
    const created = await db.project.create({ data: { slug, name: "Client test" } });
    assert.equal(created.stage, "intake");
    assert.equal(created.lanes, 2);
    const read = await db.project.findUniqueOrThrow({ where: { slug } });
    assert.equal(read.id, created.id);
    assert.equal(read.capUsd.toString(), "15");
  } finally {
    // RESTRICT allows deleting a project with no history; keep the test database clean.
    await db.project.deleteMany({ where: { slug } });
    await db.$disconnect();
  }
});

test("AT9 createDb refuses an empty URL", () => {
  assert.throws(() => createDb(""), /databaseUrl is required/);
});
