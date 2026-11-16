// SM-18-L1 (cache): every entry has a time to live, a write through `write()` drops the key, and a load that
// began before a write can never put its older value back after it (no stale read after a write).
export function createCache({ ttlMs, max = 1000, now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError("cache: ttlMs (a positive whole number of ms) is required");
  if (!Number.isInteger(max) || max < 1) throw new TypeError("cache: max must be a positive integer");
  const entries = new Map();   // key → { value, expires }; Map order doubles as least-recently-used order
  const gens = new Map();      // key → generation, bumped by every invalidation
  const loading = new Map();   // key → { gen, promise } for one shared load per key and generation

  const key = (k) => { if (typeof k !== "string" || !k) throw new TypeError("cache: keys are non-empty strings"); return k; };
  const gen = (k) => gens.get(k) ?? 0;

  function invalidate(k) {
    key(k);
    entries.delete(k); loading.delete(k);
    gens.set(k, gen(k) + 1);
  }

  // Read-through. Errors are never cached.
  async function get(k, loader) {
    key(k);
    if (typeof loader !== "function") throw new TypeError("cache: a loader is required");
    const hit = entries.get(k);
    if (hit && hit.expires > now()) { entries.delete(k); entries.set(k, hit); return hit.value; }
    if (hit) entries.delete(k);
    const g = gen(k);
    const pending = loading.get(k);
    if (pending && pending.gen === g) return pending.promise;
    const promise = (async () => {
      try {
        const value = await loader(k);
        if (gen(k) === g) {   // still current: no write happened while loading
          entries.delete(k); entries.set(k, { value, expires: now() + ttlMs });
          while (entries.size > max) entries.delete(entries.keys().next().value);
        }
        return value;
      } finally {
        if (loading.get(k)?.promise === promise) loading.delete(k);
      }
    })();
    loading.set(k, { gen: g, promise });
    return promise;
  }

  // Runs the write, then drops the keys. The keys are also dropped before the write, so a read that starts
  // during the write loads again instead of serving the old value. Dropped even when the write fails, because
  // a failed write may have changed the source.
  async function write(keys, writer) {
    const list = (Array.isArray(keys) ? keys : [keys]).map(key);
    if (typeof writer !== "function") throw new TypeError("cache: a writer is required");
    for (const k of list) invalidate(k);
    try { return await writer(); }
    finally { for (const k of list) invalidate(k); }
  }

  return { get, write, invalidate, get size() { return entries.size; } };
}
