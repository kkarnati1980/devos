// SM-06 add-on tests. SM-06-L1: related writes share a transaction, foreign keys are indexed, the pool limit is set.
// SM-06-L2: each migration is backward-compatible with the previous release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolConfig, withTransaction } from "../src/db.mjs";
import { checkSql, main, statements } from "../src/migrations-check.mjs";

const rules = (sql) => checkSql(sql).refused.map((r) => r.rule);

test("SM-06-L2: statements that break the previous release are refused; their expand-only forms pass", () => {
  const refused = {
    "DROP TABLE users;": "drop-object",
    "DROP FUNCTION f();": "drop-object",
    "DROP SEQUENCE s;": "drop-object",
    "ALTER MATERIALIZED VIEW mv RENAME TO mv2;": "rename",
    "ALTER SEQUENCE s RENAME TO t;": "rename",
    // Pre-review: Prisma's multi-clause adds, quoted schema-qualified names, ONLY/aliases, WHERE only in a literal
    // or a subquery, CTEs and RETURNING.
    'ALTER TABLE "User" ADD COLUMN "a" TEXT NOT NULL DEFAULT \'x\', ADD COLUMN "b" INTEGER NOT NULL;': "add-not-null-without-default",
    'UPDATE "public"."User" SET "plan" = \'free\';': "update-without-where",
    'DELETE FROM "public"."User";': "delete-without-where",
    "UPDATE ONLY users SET plan = 'free';": "update-without-where",
    "UPDATE users u SET plan = 'free';": "update-without-where",
    "UPDATE users SET note = 'WHERE';": "update-without-where",
    "UPDATE users SET plan = (SELECT p FROM t WHERE t.id = 1);": "update-without-where",
    "DELETE FROM users RETURNING *;": "delete-without-where",
    "WITH x AS (SELECT 1 WHERE true) DELETE FROM users;": "delete-without-where",
    'DELETE FROM "my users";': "delete-without-where",
    "ALTER TABLE users DROP COLUMN email;": "drop-column",
    'ALTER TABLE "users" DROP "email";': "drop-column",
    "ALTER TABLE users RENAME COLUMN email TO mail;": "rename",
    "ALTER TABLE users RENAME TO people;": "rename",
    "ALTER TABLE users ALTER COLUMN age TYPE bigint;": "column-type-change",
    "ALTER TABLE users ALTER COLUMN age SET DATA TYPE text;": "column-type-change",
    "ALTER TABLE users ALTER COLUMN email SET NOT NULL;": "set-not-null",
    "ALTER TABLE users ADD COLUMN plan text NOT NULL;": "add-not-null-without-default",
    "ALTER TABLE users ALTER COLUMN plan DROP DEFAULT;": "drop-default",
    "TRUNCATE users;": "truncate",
    "DELETE FROM users;": "delete-without-where",
    "UPDATE users SET plan = 'free';": "update-without-where",
  };
  for (const [sql, rule] of Object.entries(refused)) assert.deepEqual(rules(sql), [rule], sql);
  const fine = [
    "CREATE TABLE users (id uuid PRIMARY KEY, email text);",
    "ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free';",
    "ALTER TABLE users ADD COLUMN nickname text;",
    "ALTER TABLE users ALTER COLUMN email DROP NOT NULL;",
    "ALTER TABLE users DROP CONSTRAINT users_email_key;",
    "ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';",
    "DELETE FROM users WHERE deleted_at < now() - interval '30 days';",
    "UPDATE users SET plan = 'free' WHERE plan IS NULL;",
    "CREATE INDEX users_email_idx ON users (email);",
    "-- DROP TABLE users; (a comment)\nSELECT 1;",
    "INSERT INTO notes (body) VALUES ('DROP TABLE users; is only text');",
    "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM users; END $$ LANGUAGE plpgsql;",
    "ALTER TABLE users ADD COLUMN note text DEFAULT 'drop me, rename, set not null';",
    "ALTER TABLE users ADD COLUMN n int NOT NULL GENERATED ALWAYS AS IDENTITY;",
    "ALTER TABLE users ADD COLUMN id2 bigserial NOT NULL;",
    'UPDATE "public"."User" u SET "plan" = \'free\' WHERE u."plan" IS NULL;',
  ];
  for (const sql of fine) assert.deepEqual(rules(sql), [], sql);
});

test("SM-06-L2: a contract step needs a reasoned comment right above it, and is reported, not silent", () => {
  const ok = checkSql("-- sm06: contract email moved to contacts in release 12; nothing reads it since 13\nALTER TABLE users DROP COLUMN email;");
  assert.deepEqual(ok.refused, []);
  assert.equal(ok.allowed.length, 1);
  assert.match(ok.allowed[0].reason, /release 12/);
  // Too short a reason, a comment not directly above, or one covering a later statement: still refused.
  assert.deepEqual(rules("-- sm06: contract later\nALTER TABLE users DROP COLUMN email;"), ["drop-column"]);
  assert.deepEqual(rules("-- sm06: contract email moved to contacts in release 12\nSELECT 1;\nDROP TABLE users;"), ["drop-object"]);
  assert.deepEqual(rules("-- sm06: contract           x\nALTER TABLE users DROP COLUMN email;"), ["drop-column"], "padding is not a reason");
  assert.equal(statements("SELECT 1; SELECT 2;").length, 2);
  // An E'' string's backslash escape does not hide the statements after it.
  assert.deepEqual(rules("SELECT E'\\''; DROP TABLE users;"), ["drop-object"]);
});

test("SM-06-L1: a foreign key without an index that leads with it is a warning; an index or key clears it", () => {
  const sql = `
    CREATE TABLE orders (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), shop_id uuid, note text,
      CONSTRAINT orders_shop_fk FOREIGN KEY (shop_id) REFERENCES shops (id));
    ALTER TABLE orders ADD CONSTRAINT orders_note_fk FOREIGN KEY (note) REFERENCES notes (id);
    ALTER TABLE orders ADD COLUMN coupon_id uuid REFERENCES coupons(id);`;
  assert.deepEqual(checkSql(sql).warnings.sort(), [
    "orders.coupon_id references coupons but no index leads with it",
    "orders.note references notes but no index leads with it",
    "orders.shop_id references shops but no index leads with it",
    "orders.user_id references users but no index leads with it",
  ]);
  const fixed = sql + "\nCREATE INDEX orders_user_idx ON orders (user_id, id);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS orders_shop_idx ON orders USING btree (shop_id);\nCREATE UNIQUE INDEX ON orders (note);\nCREATE INDEX ON orders (coupon_id);";
  assert.deepEqual(checkSql(fixed).warnings, []);
});

// Codex PR125-r1 findings 1–3.
test("SM-06-L2: a line comment ends at its newline but still separates words (r1 finding 1)", () => {
  assert.deepEqual(rules("DROP-- x\nTABLE users;"), ["drop-object"]);
  assert.deepEqual(rules("ALTER TABLE users DROP-- why\nCOLUMN email;"), ["drop-column"]);
  assert.equal(statements("DROP-- x\nTABLE users;")[0].text, "DROP TABLE users");
});

test("SM-06-L2: block comments nest as in Postgres, so a statement after an inner */ is not hidden (r1 finding 2)", () => {
  assert.deepEqual(rules("/* a /* b */ DROP TABLE users; */ SELECT 1;"), []);
  assert.deepEqual(rules("/* a /* b */ c */ DROP TABLE users;"), ["drop-object"]);
  assert.deepEqual(statements("/* a /* b */ c */ SELECT 1;").map((s) => s.text), ["SELECT 1"]);
});

test("SM-06-L1: separately quoted schema and table names are matched by the foreign-key index scan (r1 finding 3)", () => {
  const sql = `
    CREATE TABLE "public"."orders" ("id" uuid PRIMARY KEY, "user_id" uuid REFERENCES "public"."users"("id"));
    ALTER TABLE "public"."orders" ADD CONSTRAINT "o_shop_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");
    ALTER TABLE ONLY "public"."orders" ADD COLUMN "coupon_id" uuid REFERENCES "public"."coupons"("id");`;
  assert.deepEqual(checkSql(sql).warnings.sort(), [
    "orders.coupon_id references coupons but no index leads with it",
    "orders.shop_id references shops but no index leads with it",
    "orders.user_id references users but no index leads with it",
  ]);
  const fixed = sql + `
    CREATE INDEX "o_user_idx" ON "public"."orders"("user_id");
    CREATE INDEX "o_shop_idx" ON "public"."orders" USING btree ("shop_id");
    CREATE INDEX ON public."orders" ("coupon_id");`;
  assert.deepEqual(checkSql(fixed).warnings, []);
});

test("SM-06-L2: the CLI exits 1 on a refused migration, 0 on a clean one, 1 on a warning only with --strict, 2 on bad usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm06-"));
  mkdirSync(join(dir, "migrations/2026"), { recursive: true });
  writeFileSync(join(dir, "migrations/2026/001_init.sql"), "CREATE TABLE users (id uuid PRIMARY KEY);\nCREATE TABLE orders (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id));");
  const lines = [];
  const run = (argv) => main(argv, { cwd: dir, log: (l) => lines.push(l) });
  assert.equal(run([]), 0, lines.join("\n"));
  assert.ok(lines.some((l) => /^WARN .*orders\.user_id/.test(l)));
  assert.equal(run(["--strict"]), 1);
  writeFileSync(join(dir, "migrations/2026/002_drop.sql"), "ALTER TABLE users DROP COLUMN email;");
  lines.length = 0;
  assert.equal(run([]), 1);
  assert.ok(lines.some((l) => /^REFUSED .*002_drop\.sql drop-column/.test(l)), lines.join("\n"));
  assert.equal(run(["--bogus"]), 2);
  // Named files (a PR's new migrations) are the only ones read; an unreadable one is an error.
  lines.length = 0;
  assert.equal(run(["migrations/2026/001_init.sql"]), 0, lines.join("\n"));
  assert.ok(lines.some((l) => /1 file\(s\), 0 refused/.test(l)));
  assert.equal(run(["migrations/2026/missing.sql"]), 2);
  assert.equal(run(["notes.txt"]), 2);
  assert.equal(run([join(dir, "migrations/2026/001_init.sql")]), 0, "an absolute path is read as given");
  assert.equal(run(["--dir", "nothing-here"]), 0, "no migrations folder: nothing to check");
});

test("SM-06-L1: the pool limit is required and range-checked; timeouts have bounded defaults", () => {
  assert.throws(() => poolConfig({}), /DB_POOL_MAX is required/);
  for (const bad of ["0", "51", "-1", "5.5", "ten", " 5"]) assert.throws(() => poolConfig({ DB_POOL_MAX: bad }), /DB_POOL_MAX/, bad);
  assert.deepEqual({ ...poolConfig({ DB_POOL_MAX: "10" }) }, { max: 10, statementTimeoutMs: 10_000, connectTimeoutMs: 5_000 });
  assert.equal(poolConfig({ DB_POOL_MAX: "1", DB_STATEMENT_TIMEOUT_MS: "250" }).statementTimeoutMs, 250);
  assert.throws(() => poolConfig({ DB_POOL_MAX: "1", DB_STATEMENT_TIMEOUT_MS: "99" }), /DB_STATEMENT_TIMEOUT_MS/);
  assert.throws(() => poolConfig({ DB_POOL_MAX: "1", DB_CONNECT_TIMEOUT_MS: "60001" }), /DB_CONNECT_TIMEOUT_MS/);
});

test("SM-06-L1: withTransaction commits related writes together and rolls all of them back on a throw", async () => {
  const fake = () => {
    const log = [];
    return { log, query: async (sql) => { log.push(sql); if (sql === "FAIL") throw new Error("write failed"); } };
  };
  const ok = fake();
  assert.equal(await withTransaction(ok, async (c) => { await c.query("INSERT a"); await c.query("INSERT b"); return 7; }), 7);
  assert.deepEqual(ok.log, ["BEGIN", "INSERT a", "INSERT b", "COMMIT"]);
  const bad = fake();
  await assert.rejects(withTransaction(bad, async (c) => { await c.query("INSERT a"); await c.query("FAIL"); }), /write failed/);
  assert.deepEqual(bad.log, ["BEGIN", "INSERT a", "FAIL", "ROLLBACK"]);
  // A failing ROLLBACK never hides the original error; nesting on one client is refused; the client is reusable after.
  const worse = { query: async (sql) => { if (sql !== "BEGIN") throw new Error(sql === "ROLLBACK" ? "rollback failed" : "boom"); } };
  await assert.rejects(withTransaction(worse, async (c) => c.query("X")), /boom/);
  const nest = fake();
  await assert.rejects(withTransaction(nest, (c) => withTransaction(c, async () => {})), /already inside a transaction/);
  assert.deepEqual(nest.log, ["BEGIN", "ROLLBACK"]);
  assert.equal(await withTransaction(nest, async () => "again"), "again");
  await assert.rejects(withTransaction({}, async () => {}), TypeError);
});

// Codex PR125-r2 findings 1–2.
test("SM-06-L2: a quoted identifier named like WHERE is not read as a WHERE clause (r2 finding 1)", () => {
  assert.deepEqual(rules('DELETE FROM "where";'), ["delete-without-where"]);
  assert.deepEqual(rules('UPDATE users SET "where" = true;'), ["update-without-where"]);
  assert.deepEqual(rules('UPDATE users SET "where" = true WHERE id = 1;'), []);
  assert.deepEqual(rules('DELETE FROM "where" WHERE "where"."id" = 1;'), []);
});

test("SM-06-L1: an index clears a foreign-key warning only on the same schema and table, with Postgres name folding (r2 finding 2)", () => {
  const other = "CREATE TABLE sales.orders (user_id uuid REFERENCES users(id));\nCREATE INDEX ON archive.orders (user_id);";
  assert.deepEqual(checkSql(other).warnings, ["sales.orders.user_id references users but no index leads with it"]);
  assert.deepEqual(checkSql(other + "\nCREATE INDEX ON sales.orders (user_id);").warnings, []);
  // Unqualified means public; unquoted names fold to lower case, quoted ones keep their case.
  assert.deepEqual(checkSql('CREATE TABLE Orders (user_id uuid REFERENCES users(id));\nCREATE INDEX ON public.orders (USER_ID);').warnings, []);
  assert.deepEqual(checkSql('CREATE TABLE "Orders" ("userId" uuid REFERENCES "User"("id"));\nCREATE INDEX ON orders ("userId");').warnings,
    ["Orders.userId references User but no index leads with it"]);
  assert.deepEqual(checkSql('CREATE TABLE "Orders" ("userId" uuid REFERENCES "User"("id"));\nCREATE INDEX ON "Orders" ("userId");').warnings, []);
});
