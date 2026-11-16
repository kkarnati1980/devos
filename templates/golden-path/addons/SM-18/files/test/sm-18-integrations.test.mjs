// SM-18-L1: each sub-part is implemented — webhook signature with timestamp and replay protection, payment
// event dedupe and out-of-order handling, cache TTL with invalidation on write, encrypted least-scope tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { IntegrationError } from "../src/integration-error.mjs";
import { memoryReplayStore, readRawBody, signWebhook, verifyWebhook } from "../src/webhook.mjs";
import { createEventLedger } from "../src/events.mjs";
import { createCache } from "../src/cache.mjs";
import { createTokenVault, loadTokenKeys } from "../src/token-vault.mjs";

const code = (c) => (e) => { assert.ok(e instanceof IntegrationError, String(e)); assert.equal(e.code, c, e.message); return true; };
const later = (ms) => new Promise((r) => setTimeout(r, ms));

test("SM-18-L1 webhook: signature over timestamp and raw body, time window, replay refused", async () => {
  const secret = randomBytes(32).toString("hex"); const other = randomBytes(32).toString("hex");
  let clock = 1_800_000_000_000; const now = () => clock;
  const ts = Math.floor(clock / 1000);
  const body = Buffer.from('{"id":"evt_1","amount":1200}');
  const sig = signWebhook({ secret, body, timestamp: ts });
  const replay = memoryReplayStore({ now });
  const v = (o) => verifyWebhook({ secrets: secret, body, signature: sig, timestamp: String(ts), replay, now, ...o });

  const first = await v();
  assert.equal(first.timestamp, ts);
  await assert.rejects(v(), code("replayed"), "the same delivery twice");
  await first.release();   // processing failed and the app answered 5xx: the provider's resend is accepted once
  const resend = await v(); assert.equal(resend.timestamp, ts);
  await assert.rejects(v(), code("replayed"));
  await assert.rejects(v({ signature: undefined }), code("signature-missing"));
  await assert.rejects(v({ signature: "zz" }), code("signature-invalid"));
  await assert.rejects(v({ signature: signWebhook({ secret: other, body, timestamp: ts }) }), code("signature-invalid"), "wrong secret");
  await assert.rejects(v({ body: Buffer.from('{"id":"evt_1","amount":9999}') }), code("signature-invalid"), "body changed");
  await assert.rejects(v({ timestamp: String(ts + 1) }), code("signature-invalid"), "timestamp changed without re-signing");
  await assert.rejects(v({ timestamp: "1e9" }), code("timestamp-invalid"));
  await assert.rejects(v({ body: JSON.parse(body) }), TypeError, "parsed JSON is not the signed bytes");

  const old = ts - 301; const oldSig = signWebhook({ secret, body, timestamp: old });
  await assert.rejects(v({ signature: oldSig, timestamp: old }), code("stale"), "a captured delivery replayed after the window");
  const ahead = ts + 301;
  await assert.rejects(v({ signature: signWebhook({ secret, body, timestamp: ahead }), timestamp: ahead }), code("stale"));
  assert.equal(replay.size, 1, "a refused delivery never fills the replay store");

  // Secret rotation: either secret verifies.
  const t2 = ts + 5; const s2 = signWebhook({ secret: other, body, timestamp: t2 });
  assert.equal((await v({ secrets: [secret, other], signature: s2.toUpperCase(), timestamp: t2 })).timestamp, t2);
  assert.throws(() => signWebhook({ secret: "short", body, timestamp: ts }), TypeError);
  await assert.rejects(verifyWebhook({ secrets: secret, body, signature: sig, timestamp: ts }), TypeError, "no replay store");
  await assert.rejects(verifyWebhook({ secrets: secret, body, signature: sig, timestamp: ts, replay: { claim: () => true } }), TypeError, "a store without release");

  // The replay store forgets an entry only after it could no longer pass the window, and refuses when full.
  clock += 302_000;
  const small = memoryReplayStore({ now, max: 1 });
  assert.equal(small.claim("a", clock + 1000), true);
  assert.throws(() => small.claim("b", clock + 1000), code("replay-store-full"));
  clock += 1001;
  assert.equal(small.claim("b", clock + 1000), true, "expired entries are pruned");

  // The raw body is read with a cap.
  assert.equal((await readRawBody(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 4)).toString(), "abcd");
  await assert.rejects(readRawBody(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), 4), code("too-large"));
  const declared = Readable.from([]); declared.headers = { "content-length": "5" };
  await assert.rejects(readRawBody(declared, 4), code("too-large"));
});

test("SM-18-L1 payment events: duplicates applied once, an older event never undoes a newer one", async () => {
  const ledger = createEventLedger({ rank: { "payment.pending": 1, "payment.succeeded": 2, "payment.refunded": 3 } });
  const state = new Map(); let calls = 0;
  const handler = async (e) => { calls++; await later(5); state.set(e.objectId, e.type); };
  const ev = (id, type, version, objectId = "pay_1") => ({ id, objectId, type, version });

  assert.deepEqual(await ledger.apply(ev("e1", "payment.succeeded", 100), handler), { status: "applied" });
  assert.deepEqual(await ledger.apply(ev("e1", "payment.succeeded", 100), handler), { status: "duplicate" });
  assert.deepEqual(await ledger.apply(ev("e0", "payment.pending", 90), handler), { status: "stale" }, "arrived late");
  assert.deepEqual(await ledger.apply(ev("e0b", "payment.pending", 100), handler), { status: "stale" }, "same second, earlier state");
  assert.equal(state.get("pay_1"), "payment.succeeded"); assert.equal(calls, 1);
  assert.deepEqual(await ledger.apply(ev("e0", "payment.pending", 90), handler), { status: "duplicate" }, "a stale event is remembered too");

  // Concurrent deliveries of one event: applied once.
  const results = await Promise.all([1, 2, 3].map(() => ledger.apply(ev("e2", "payment.refunded", 120), handler)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["applied", "duplicate", "duplicate"]);
  assert.equal(calls, 2); assert.equal(state.get("pay_1"), "payment.refunded");

  // Concurrent out-of-order events for one object: the newest wins whatever order they finish in.
  await Promise.all([ledger.apply(ev("f2", "payment.succeeded", 200, "pay_2"), handler), ledger.apply(ev("f1", "payment.pending", 150, "pay_2"), handler)]);
  assert.equal(state.get("pay_2"), "payment.succeeded");

  // A failing handler records nothing, so the provider's retry is applied.
  await assert.rejects(ledger.apply(ev("g1", "payment.succeeded", 10, "pay_3"), async () => { throw new Error("db down"); }), /db down/);
  assert.deepEqual(await ledger.apply(ev("g1", "payment.succeeded", 10, "pay_3"), handler), { status: "applied" });

  for (const bad of [null, ev("", "x", 1), ev("h1", "x", -1), ev("h1", "x", 1.5), ev("h1", "", 1), ev("h1", "x", 1, "a b")]) {
    await assert.rejects(ledger.apply(bad, handler), code("event-invalid"));
  }
  assert.throws(() => createEventLedger({ store: {} }), TypeError);

  // A database store: check, handler and record run in one transaction; a failed record rolls the handler back.
  const db = { ids: new Set(), orders: new Map(), rows: new Map() };
  let failCommit = true;
  const txStore = {
    async transaction(fn) {
      const tx = { ids: new Set(db.ids), orders: new Map(db.orders), rows: new Map(db.rows) };
      const r = await fn(tx);
      Object.assign(db, tx);   // commit only when fn returned
      return r;
    },
    hasEvent: (id, tx) => tx.ids.has(id),
    lastOrder: (o, tx) => tx.orders.get(o) ?? null,
    commit({ id, objectId, order, applied }, tx) {
      if (failCommit) throw new Error("commit failed");
      tx.ids.add(id); if (applied) tx.orders.set(objectId, order);
    },
  };
  const dbLedger = createEventLedger({ store: txStore });
  const write = (e, tx) => { tx.rows.set(e.objectId, e.type); };
  await assert.rejects(dbLedger.apply(ev("t1", "payment.succeeded", 1, "pay_9"), write), /commit failed/);
  assert.equal(db.rows.size, 0, "the handler's write rolled back with the failed record");
  failCommit = false;
  assert.deepEqual(await dbLedger.apply(ev("t1", "payment.succeeded", 1, "pay_9"), write), { status: "applied" });
  assert.equal(db.rows.get("pay_9"), "payment.succeeded");
  assert.deepEqual(await dbLedger.apply(ev("t1", "payment.succeeded", 1, "pay_9"), write), { status: "duplicate" });
  assert.throws(() => createEventLedger({ store: { ...txStore, transaction: 1 } }), TypeError);
});

test("SM-18-L1 cache: TTL, invalidation on write, no stale value after a write", async () => {
  let clock = 0; const now = () => clock;
  let source = "v1"; let loads = 0;
  const loader = async () => { loads++; const v = source; await later(10); return v; };
  const cache = createCache({ ttlMs: 1000, max: 2, now });

  assert.equal(await cache.get("k", loader), "v1");
  assert.equal(await cache.get("k", loader), "v1"); assert.equal(loads, 1, "served from the cache");
  clock += 1001; source = "v2";
  assert.equal(await cache.get("k", loader), "v2", "expired after the TTL"); assert.equal(loads, 2);

  // A write drops the key: the next read sees the new value at once.
  await cache.write("k", async () => { source = "v3"; });
  assert.equal(await cache.get("k", loader), "v3");

  // A load that began before a write never puts its older value back.
  clock += 2000; source = "v4";
  const slow = cache.get("k", loader);                     // reads v4, finishes after the write
  await cache.write("k", async () => { source = "v5"; });
  assert.equal(await slow, "v4");
  assert.equal(await cache.get("k", loader), "v5", "no stale read after the write");

  // A failed write still drops the key; concurrent reads share one load; errors are not cached; LRU bound.
  await assert.rejects(cache.write(["k"], async () => { source = "v6"; throw new Error("partial"); }), /partial/);
  assert.equal(await cache.get("k", loader), "v6");
  loads = 0; cache.invalidate("k");
  await Promise.all([cache.get("k", loader), cache.get("k", loader)]); assert.equal(loads, 1);
  await assert.rejects(cache.get("e", async () => { throw new Error("nope"); }), /nope/);
  assert.equal(await cache.get("e", async () => "ok"), "ok");
  await assert.rejects(cache.get("s", () => { throw new Error("sync"); }), /sync/);
  assert.equal(await cache.get("s", async () => "ok"), "ok", "a loader that throws at once is not kept");
  cache.invalidate("s");
  await cache.get("z", async () => "z");
  assert.equal(cache.size, 2);
  assert.throws(() => createCache({}), TypeError, "a TTL is required");
  await assert.rejects(cache.get("", loader), TypeError);
});

test("SM-18-L1 tokens: encrypted at rest, bound to owner and provider, least scope", () => {
  const k1 = randomBytes(32).toString("base64"); const k2 = randomBytes(32).toString("base64");
  let clock = 1000; const now = () => clock;
  const vault = createTokenVault({ keys: loadTokenKeys(`k1:${k1}`), scopes: { google: ["calendar.readonly", "gmail.readonly"] }, now });
  const token = `ya29.${randomBytes(24).toString("hex")}`;

  assert.deepEqual(vault.scopesFor("google", ["calendar.readonly"]), ["calendar.readonly"]);
  assert.throws(() => vault.scopesFor("google", ["gmail.modify"]), code("scope-not-declared"));
  assert.throws(() => vault.scopesFor("github", ["repo"]), code("provider-not-declared"));

  const rec = vault.seal({ provider: "google", owner: "user-1", token, granted: ["calendar.readonly"], expiresAt: 5000 });
  assert.ok(!JSON.stringify(rec).includes(token) && !JSON.stringify(rec).includes(token.slice(5, 25)), "the stored record never holds the token");
  assert.equal(vault.open(rec, { provider: "google", owner: "user-1", need: ["calendar.readonly"] }), token);
  assert.notEqual(vault.seal({ provider: "google", owner: "user-1", token, granted: ["calendar.readonly"] }).iv, rec.iv, "a fresh IV each time");

  assert.throws(() => vault.seal({ provider: "google", owner: "user-1", token, granted: ["calendar.readonly", "gmail.modify"] }), code("scope-not-declared"), "a broader grant is not stored");
  assert.throws(() => vault.open(rec, { provider: "google", owner: "user-1", need: ["gmail.readonly"] }), code("scope-not-granted"));
  assert.throws(() => vault.open(rec, { provider: "google", owner: "user-2", need: ["calendar.readonly"] }), code("token-wrong-owner"));
  for (const edit of [{ owner: "user-2" }, { scopes: ["calendar.readonly", "gmail.readonly"] }, { expiresAt: 9e12 }, { ct: Buffer.from("x").toString("base64") }]) {
    const moved = { ...rec, ...edit };
    const as = { provider: "google", owner: moved.owner, need: ["calendar.readonly"] };
    assert.throws(() => vault.open(moved, as), code("token-invalid"), JSON.stringify(Object.keys(edit)));
  }
  clock = 5000;
  assert.throws(() => vault.open(rec, { provider: "google", owner: "user-1", need: ["calendar.readonly"] }), code("token-expired"));

  // Rotation: a new first key encrypts, the old one still decrypts until rewrapped; an unknown key fails.
  clock = 1000;
  const rotated = createTokenVault({ keys: loadTokenKeys(`k2:${k2},k1:${k1}`), scopes: { google: ["calendar.readonly"] }, now });
  const re = rotated.rewrap(rec);
  assert.equal(re.kid, "k2");
  assert.equal(rotated.open(re, { provider: "google", owner: "user-1", need: ["calendar.readonly"] }), token);
  const onlyNew = createTokenVault({ keys: loadTokenKeys(`k2:${k2}`), scopes: { google: ["calendar.readonly"] }, now });
  assert.throws(() => onlyNew.open(rec, { provider: "google", owner: "user-1", need: ["calendar.readonly"] }), code("token-key-unknown"));

  for (const bad of ["", "k1", `K1:${k1}`, `k1:${randomBytes(16).toString("base64")}`, `k1:${k1},k1:${k2}`]) assert.throws(() => loadTokenKeys(bad), TypeError, bad);
  assert.throws(() => loadTokenKeys(`k1:${k1.slice(0, -4)}`), (e) => e instanceof TypeError && !e.message.includes(k1.slice(0, 20)), "errors never repeat a key");
  assert.throws(() => vault.scopesFor("google", "calendar.readonly"), TypeError, "need is a list, not a string");
});
