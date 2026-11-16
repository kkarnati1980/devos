// SM-18-L1 (payment events): each provider event is applied at most once (dedupe by event id), and an event
// older than the last one applied to the same object (a payment, a subscription) is recorded but not applied,
// so a late "payment pending" can never undo "payment succeeded".
import { IntegrationError } from "./integration-error.mjs";

const ID = /^[\w.:-]{1,200}$/;

// One process only. An app with more than one instance gives the ledger a database store with the same three
// calls plus transaction(fn): fn(tx) runs inside one database transaction, and the ledger passes tx to the
// three calls and to the handler, so the handler's write and the record of the event commit together or not
// at all. lastOrder(objectId, tx) should first upsert the object's row (INSERT … ON CONFLICT DO NOTHING) and then
// lock it (SELECT … FOR UPDATE), so two instances cannot apply events for one object at once, even its first
// two events; a duplicate event id then fails the unique key and rolls back.
export function memoryEventStore({ now = Date.now, keepMs = 7 * 24 * 3600 * 1000 } = {}) {
  const events = new Map();   // event id → time seen (kept at least as long as providers retry, 3 days for most)
  const objects = new Map();  // object id → { version, rank }
  return {
    hasEvent(id) {
      const t = now();
      for (const [k, at] of events) { if (at + keepMs > t) break; events.delete(k); }
      return events.has(id);
    },
    lastOrder(objectId) { return objects.get(objectId) ?? null; },
    commit({ id, objectId, order, applied }) {
      events.delete(id); events.set(id, now());
      if (applied) objects.set(objectId, order);
    },
  };
}

// `rank` orders event types that share a version (for example two events in the same second): a later state
// gets a higher rank. Unknown types rank 0.
export function createEventLedger({ store = memoryEventStore(), rank = {} } = {}) {
  for (const k of ["hasEvent", "lastOrder", "commit"]) if (typeof store[k] !== "function") throw new TypeError(`events: store.${k} is required`);
  const ranks = new Map(Object.entries(rank));
  for (const v of ranks.values()) if (!Number.isInteger(v)) throw new TypeError("events: ranks must be integers");
  if (store.transaction !== undefined && typeof store.transaction !== "function") throw new TypeError("events: store.transaction must be a function");
  const run = store.transaction ? (fn) => store.transaction(fn) : (fn) => fn(undefined);
  const chains = new Map();   // object id → tail promise, so one object's events run one at a time

  function check(event) {
    if (!event || typeof event !== "object") throw new IntegrationError("event-invalid", "event missing");
    const { id, objectId, version, type } = event;
    if (typeof id !== "string" || !ID.test(id)) throw new IntegrationError("event-invalid", "event id invalid");
    if (typeof objectId !== "string" || !ID.test(objectId)) throw new IntegrationError("event-invalid", "event object id invalid");
    if (!Number.isSafeInteger(version) || version < 0) throw new IntegrationError("event-invalid", "event version must be a whole number");
    if (typeof type !== "string" || !type) throw new IntegrationError("event-invalid", "event type invalid");
    return { version, rank: ranks.has(type) ? ranks.get(type) : 0 };
  }
  const older = (a, b) => a.version < b.version || (a.version === b.version && a.rank < b.rank);

  // Runs `handler(event)` only for a new event that is not older than the object's last applied one.
  // Returns { status: "applied" | "duplicate" | "stale" }. If the handler throws, nothing is recorded, so the
  // provider's retry is applied later.
  async function apply(event, handler) {
    if (typeof handler !== "function") throw new TypeError("events: a handler is required");
    const order = check(event);
    const prev = chains.get(event.objectId) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const tail = prev.then(() => mine);
    chains.set(event.objectId, tail);
    await prev;
    try {
      return await run(async (tx) => {
        if (await store.hasEvent(event.id, tx)) return { status: "duplicate" };
        const last = await store.lastOrder(event.objectId, tx);
        if (last && older(order, last)) {
          await store.commit({ id: event.id, objectId: event.objectId, order, applied: false }, tx);
          return { status: "stale" };
        }
        await handler(event, tx);
        await store.commit({ id: event.id, objectId: event.objectId, order, applied: true }, tx);
        return { status: "applied" };
      });
    } finally {
      release();
      if (chains.get(event.objectId) === tail) chains.delete(event.objectId);
    }
  }
  return { apply };
}
