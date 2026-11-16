// SM-18-L1 (third-party tokens): OAuth and API tokens from other services are stored encrypted (AES-256-GCM,
// a key from the server's config, bound to the owner and the provider) and with the least scope: only scopes
// the app declared for that provider can be stored, and a token is opened only for a scope it was granted.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { IntegrationError } from "./integration-error.mjs";

const KID = /^[a-z0-9-]{1,32}$/;
const NAME = /^[\w.:@-]{1,200}$/;

// TOKEN_KEYS="<id>:<base64 of 32 random bytes>[,<old id>:<old key>…]" — the first key encrypts, every listed
// key can decrypt (so a key can be rotated). Set it in the server's secret store, never in the repo.
// Make a key with: openssl rand -base64 32
export function loadTokenKeys(text) {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("token-vault: TOKEN_KEYS is not set");
  const keys = new Map();
  for (const part of text.split(",")) {
    const i = part.indexOf(":");
    const kid = part.slice(0, i).trim(); const b64 = part.slice(i + 1).trim();
    if (i < 1 || !KID.test(kid)) throw new TypeError("token-vault: each TOKEN_KEYS entry is <id>:<base64 key>");
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32 || key.toString("base64") !== b64) throw new TypeError(`token-vault: key ${kid} is not 32 bytes of base64`);
    if (keys.has(kid)) throw new TypeError(`token-vault: key id ${kid} is listed twice`);
    keys.set(kid, key);
  }
  return { current: keys.keys().next().value, keys };
}

// `scopes` is the app's declared need per provider, e.g. { google: ["calendar.readonly"] }.
export function createTokenVault({ keys, scopes, now = Date.now }) {
  if (!keys || !(keys.keys instanceof Map) || !keys.keys.has(keys.current)) throw new TypeError("token-vault: keys from loadTokenKeys() are required");
  if (!scopes || typeof scopes !== "object") throw new TypeError("token-vault: the declared scopes per provider are required");
  const declared = new Map();
  for (const [p, list] of Object.entries(scopes)) {
    if (!NAME.test(p) || !Array.isArray(list) || !list.length || !list.every((s) => typeof s === "string" && s && !/\s/.test(s))) {
      throw new TypeError(`token-vault: declared scopes for ${p} must be a non-empty list of scope names`);
    }
    declared.set(p, new Set(list));
  }

  const aad = (v, kid, provider, owner, scopeList, expiresAt) =>
    Buffer.from(JSON.stringify(["sm18-token", v, kid, provider, owner, scopeList, expiresAt]), "utf8");
  const name = (what, x) => { if (typeof x !== "string" || !NAME.test(x)) throw new TypeError(`token-vault: ${what} is invalid`); return x; };

  // The scopes to ask the provider for: only what this feature needs, and only if the app declared it.
  function scopesFor(provider, need) {
    const allowed = declared.get(name("provider", provider));
    if (!allowed) throw new IntegrationError("provider-not-declared", "provider not declared");
    if (!Array.isArray(need)) throw new TypeError("token-vault: need is a list of scope names");
    const list = [...new Set(need)];
    if (!list.length) throw new TypeError("token-vault: name the scopes this feature needs");
    for (const s of list) if (!allowed.has(s)) throw new IntegrationError("scope-not-declared", `scope not declared for ${provider}: ${s}`);
    return list.sort();
  }

  // Encrypts a token for storage. `granted` is the scope list the provider says it granted.
  function seal({ provider, owner, token, granted, expiresAt = null }) {
    name("owner", owner);
    if (typeof token !== "string" || !token) throw new TypeError("token-vault: token must be a non-empty string");
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw new TypeError("token-vault: expiresAt is ms since the epoch, or null");
    const scopeList = scopesFor(provider, Array.isArray(granted) ? granted : []);   // a broader grant is refused, not stored
    const kid = keys.current; const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", keys.keys.get(kid), iv);
    c.setAAD(aad(1, kid, provider, owner, scopeList, expiresAt));
    const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
    return { v: 1, kid, provider, owner, scopes: scopeList, expiresAt, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }

  // Decrypts a stored token for one owner and the scopes one call needs. A record moved to another owner or
  // provider, or with its scopes or expiry edited, fails to decrypt.
  function open(record, { provider, owner, need }) {
    if (!record || record.v !== 1) throw new IntegrationError("token-invalid", "stored token invalid");
    if (record.provider !== provider || record.owner !== owner) throw new IntegrationError("token-wrong-owner", "stored token belongs to another owner or provider");
    const want = scopesFor(provider, Array.isArray(need) ? need : []);
    const key = keys.keys.get(record.kid);
    if (!key) throw new IntegrationError("token-key-unknown", "stored token key is not configured");
    let token;
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"), { authTagLength: 16 });
      d.setAAD(aad(1, record.kid, provider, owner, record.scopes, record.expiresAt));
      d.setAuthTag(Buffer.from(record.tag, "base64"));
      token = Buffer.concat([d.update(Buffer.from(record.ct, "base64")), d.final()]).toString("utf8");
    } catch { throw new IntegrationError("token-invalid", "stored token invalid"); }
    const granted = new Set(record.scopes);
    for (const s of want) if (!granted.has(s)) throw new IntegrationError("scope-not-granted", `scope not granted: ${s}`);
    if (record.expiresAt !== null && record.expiresAt <= now()) throw new IntegrationError("token-expired", "stored token expired");
    return token;
  }

  // Re-encrypts a record under the current key (key rotation).
  function rewrap(record) {
    const token = open(record, { provider: record.provider, owner: record.owner, need: record.scopes });
    return seal({ provider: record.provider, owner: record.owner, token, granted: record.scopes, expiresAt: record.expiresAt });
  }

  return { scopesFor, seal, open, rewrap };
}
