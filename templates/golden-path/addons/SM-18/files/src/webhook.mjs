// SM-18-L1 (webhooks): an incoming webhook is accepted only with a valid HMAC-SHA256 signature over its
// timestamp and its raw body, a timestamp inside the tolerance window, and a signature not seen before.
import { createHmac, timingSafeEqual } from "node:crypto";
import { IntegrationError } from "./integration-error.mjs";

export const WEBHOOK_DEFAULTS = Object.freeze({ toleranceSec: 300, maxBytes: 1024 * 1024 });
const HEX64 = /^[0-9a-f]{64}$/;
const TS = /^[0-9]{1,12}$/;

function asBytes(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new TypeError("webhook: body must be the raw request bytes (a Buffer or string), never parsed JSON");
}

function checkSecret(secret) {
  const b = Buffer.isBuffer(secret) ? secret : typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!b || b.length < 16) throw new TypeError("webhook: a secret of at least 16 bytes is required");
  return b;
}

// Signs `<timestamp>.<body>`; for tests and for webhooks this app sends.
export function signWebhook({ secret, body, timestamp }) {
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new TypeError("webhook: timestamp must be whole seconds");
  return createHmac("sha256", checkSecret(secret)).update(`${timestamp}.`).update(asBytes(body)).digest("hex");
}

// Remembers accepted signatures until they could no longer pass the time window. One process only: an app
// with more than one instance passes a shared store with the same claim(key, expiresAtMs) → boolean and
// release(key) contract, e.g. an INSERT into a table with a unique key that returns false on conflict.
export function memoryReplayStore({ now = Date.now, max = 100_000 } = {}) {
  const seen = new Map();
  return {
    claim(key, expiresAtMs) {
      const t = now();
      const exp = seen.get(key);
      if (exp !== undefined && exp > t) return false;
      if (seen.size >= max) for (const [k, e] of seen) if (e <= t) seen.delete(k);
      // Full of live entries: refuse rather than forget one (forgetting would let that webhook replay). The
      // sender retries later.
      if (seen.size >= max) throw new IntegrationError("replay-store-full", "webhook replay store full");
      seen.set(key, expiresAtMs);
      return true;
    },
    release(key) { seen.delete(key); },
    get size() { return seen.size; },
  };
}

// Order: signature first (so an unsigned request can never fill the replay store), then the time window, then
// the replay claim. `secrets` may hold more than one secret while a secret is rotated.
export async function verifyWebhook({ secrets, body, signature, timestamp, replay, now = Date.now, toleranceSec = WEBHOOK_DEFAULTS.toleranceSec }) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).map(checkSecret);
  if (!keys.length) throw new TypeError("webhook: at least one secret is required");
  if (!replay || typeof replay.claim !== "function" || typeof replay.release !== "function") throw new TypeError("webhook: a replay store is required");
  if (!Number.isInteger(toleranceSec) || toleranceSec < 1 || toleranceSec > 900) throw new TypeError("webhook: toleranceSec must be 1–900");
  const bytes = asBytes(body);
  if (typeof signature !== "string" || !signature) throw new IntegrationError("signature-missing", "webhook signature missing");
  const sig = signature.trim().toLowerCase();
  if (typeof timestamp !== "string" && typeof timestamp !== "number") throw new IntegrationError("timestamp-invalid", "webhook timestamp missing");
  const tsText = String(timestamp).trim();
  if (!TS.test(tsText)) throw new IntegrationError("timestamp-invalid", "webhook timestamp is not whole seconds");
  const ts = Number(tsText);
  if (!HEX64.test(sig)) throw new IntegrationError("signature-invalid", "webhook signature invalid");
  const given = Buffer.from(sig, "hex");
  let ok = false;
  for (const k of keys) {
    const want = createHmac("sha256", k).update(`${ts}.`).update(bytes).digest();
    if (timingSafeEqual(want, given)) ok = true;   // no early exit: every secret is tried
  }
  if (!ok) throw new IntegrationError("signature-invalid", "webhook signature invalid");
  const nowSec = Math.floor(now() / 1000);
  if (Math.abs(nowSec - ts) > toleranceSec) throw new IntegrationError("stale", "webhook timestamp outside the allowed window");
  const fresh = await replay.claim(`${ts}.${sig}`, (ts + toleranceSec + 1) * 1000);
  if (fresh !== true) throw new IntegrationError("replayed", "webhook already received");
  // Call release() when processing fails and the app answers 5xx, so the provider's resend is accepted.
  const key = `${ts}.${sig}`;
  return { timestamp: ts, release: async () => { await replay.release(key); } };
}

// Reads the raw body for signing, refusing a declared length over the cap before reading and cutting a body
// that grows past it.
export function readRawBody(req, maxBytes = WEBHOOK_DEFAULTS.maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("webhook: maxBytes must be a positive integer");
  return new Promise((resolve, reject) => {
    const declared = req.headers?.["content-length"];
    if (declared !== undefined && !(Number(declared) <= maxBytes)) { req.resume(); return reject(new IntegrationError("too-large", "webhook body too large")); }
    const parts = []; let size = 0; let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { done = true; parts.length = 0; req.resume(); reject(new IntegrationError("too-large", "webhook body too large")); return; }
      parts.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}
