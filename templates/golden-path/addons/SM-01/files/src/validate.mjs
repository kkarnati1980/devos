// SM-01 add-on (API input and contracts, SM-01-L1): every route validates its body, query and params against a
// schema, and invalid input gets a 4xx before the handler runs, so it never reaches the database.
// No dependencies. Schemas are plain objects:
//   { type: "object", properties: { name: { type: "string", maxLength: 80 } }, required: ["name"] }
//   string: minLength, maxLength (default 1000), pattern (RegExp), enum · integer/number: min, max
//   boolean · array: items, minItems, maxItems (default 100) · object: properties, required (unknown keys refused)
// Error messages name the field and the rule, never the value sent (no reflection of input).

const MAX_ERRORS = 20;
const DEFAULT_MAX_LENGTH = 1000;
const DEFAULT_MAX_ITEMS = 100;
export const DEFAULT_BODY_LIMIT = 100_000; // bytes
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;

const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

/** Throws on a schema mistake (unknown type, list without items, bad pattern), anywhere in the schema. */
export function checkSchema(schema, path = "(root)") {
  if (!schema || typeof schema !== "object" || !TYPES.has(schema.type)) throw new Error(`validate: bad schema at ${path}`);
  if (schema.pattern !== undefined) new RegExp(schema.pattern);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`validate: enum must be a list at ${path}`);
  for (const k of ["min", "max", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[k] !== undefined && !Number.isFinite(schema[k])) throw new Error(`validate: ${k} must be a number at ${path}`);
  }
  if (schema.type === "object") {
    for (const k of schema.required ?? []) if (!Object.hasOwn(schema.properties ?? {}, k)) throw new Error(`validate: required "${k}" is not a property at ${path}`);
  }
  if (schema.type === "array") {
    if (!schema.items) throw new Error(`validate: list without items at ${path}`);
    checkSchema(schema.items, `${path}[]`);
  }
  if (schema.type === "object") for (const [k, s] of Object.entries(schema.properties ?? {})) checkSchema(s, `${path}.${k}`);
}

/** Returns a list of `{ path, message }`; empty when `value` matches `schema`. */
export function validate(schema, value, path = "", errors = []) {
  const err = (message) => { if (errors.length < MAX_ERRORS) errors.push({ path: path || "(root)", message }); };
  if (!schema || typeof schema !== "object") throw new Error("validate: schema must be an object");
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return err("must be a string"), errors;
      const max = schema.maxLength ?? DEFAULT_MAX_LENGTH;
      // Over the cap: stop here, so no pattern ever runs on more text than the schema allows (pre-review r2, ReDoS).
      if (value.length > max) return err(`must be at most ${max} characters`), errors;
      if (schema.minLength !== undefined && value.length < schema.minLength) err(`must be at least ${schema.minLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) err("has the wrong format");
      if (schema.enum && !schema.enum.includes(value)) err("is not one of the allowed values");
      return errors;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return err(`must be ${schema.type === "integer" ? "an integer" : "a number"}`), errors;
      }
      if (schema.min !== undefined && value < schema.min) err(`must be at least ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) err(`must be at most ${schema.max}`);
      return errors;
    }
    case "boolean":
      if (typeof value !== "boolean") err("must be true or false");
      return errors;
    case "array": {
      if (!Array.isArray(value)) return err("must be a list"), errors;
      const max = schema.maxItems ?? DEFAULT_MAX_ITEMS;
      if (value.length > max) return err(`must have at most ${max} items`), errors;
      if (schema.minItems !== undefined && value.length < schema.minItems) err(`must have at least ${schema.minItems} items`);
      value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
      return errors;
    }
    case "object": {
      if (kindOf(value) !== "object") return err("must be an object"), errors;
      const props = schema.properties ?? {};
      for (const k of Object.keys(value)) {
        // The name is shown only when it is a plain identifier, so a crafted key is never echoed (no reflection).
        if (!Object.hasOwn(props, k)) err(/^[A-Za-z0-9_]{1,40}$/.test(k) ? `"${k}" is not an allowed field` : "has a field that is not allowed");
      }
      for (const k of schema.required ?? []) {
        if (!Object.hasOwn(value, k) || value[k] === undefined) {
          if (errors.length < MAX_ERRORS) errors.push({ path: path ? `${path}.${k}` : k, message: "is required" });
        }
      }
      for (const [k, s] of Object.entries(props)) {
        if (Object.hasOwn(value, k) && value[k] !== undefined) validate(s, value[k], path ? `${path}.${k}` : k, errors);
      }
      return errors;
    }
    default:
      throw new Error(`validate: unknown schema type ${JSON.stringify(schema.type)}`);
  }
}

/**
 * Query strings and route params arrive as text: turn "12" into 12 and "true"/"false" into booleans where the
 * schema asks for them, so the same schema rules apply. A repeated query key is refused unless the schema is a list.
 */
function coerce(schema, raw) {
  // Built with own data properties (Object.fromEntries), never `out[k] = …`: a `__proto__` key must stay a plain,
  // unknown field that validation refuses, not a prototype change that hides it (pre-review r1).
  const out = [];
  const props = schema?.properties ?? {};
  const one = (s, v) => {
    if ((s?.type === "integer" || s?.type === "number") && /^-?\d{1,15}(\.\d{1,15})?$/.test(v)) return Number(v);
    if (s?.type === "boolean" && (v === "true" || v === "false")) return v === "true";
    return v;
  };
  for (const [k, vals] of raw) {
    const s = Object.hasOwn(props, k) ? props[k] : undefined;
    if (s?.type === "array") out.push([k, vals.map((v) => one(s.items, v))]);
    else out.push([k, vals.length === 1 ? one(s, vals[0]) : [...vals]]); // a repeated key is a list: refused unless the schema says list
  }
  return Object.fromEntries(out);
}

const groupQuery = (url) => {
  const m = new Map();
  for (const [k, v] of new URL(url || "/", "http://app").searchParams) m.set(k, [...(m.get(k) ?? []), v]);
  return [...m];
};

/** `application/json` and the `+json` family (`application/merge-patch+json`, `application/problem+json`, …). */
const isJsonType = (t) => t === "application/json" || /^application\/[a-z0-9.-]+\+json$/.test(t);

class HttpInputError extends Error {
  constructor(status, error) { super(error); this.status = status; this.error = error; }
}

/** Reads a JSON body with a size cap and a time limit. `undefined` when the request has no body. */
export function readJson(req, { limit = DEFAULT_BODY_LIMIT, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) return Promise.reject(new HttpInputError(413, "body-too-large"));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    // Over the limit or too slow: stop buffering (the rest is discarded) and let the caller answer 413/408 first;
    // the socket is closed once that answer is sent (pre-review r1), so the client sees the status, not a reset.
    const timer = setTimeout(() => finish(reject, new HttpInputError(408, "body-timeout")), timeoutMs);
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { chunks.length = 0; finish(reject, new HttpInputError(413, "body-too-large")); return; }
      chunks.push(c);
    });
    req.on("error", () => finish(reject, new HttpInputError(400, "body-unreadable")));
    req.on("end", () => {
      if (size === 0) return finish(resolve, undefined);
      if (!isJsonType(type)) return finish(reject, new HttpInputError(415, "body-must-be-json"));
      try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(reject, new HttpInputError(400, "body-not-json")); }
    });
  });
}

const send = (res, code, obj) => {
  if (res.headersSent) return;
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  res.end(JSON.stringify(obj));
};

/**
 * Wraps a core route handler `(req, res, ctx)`. Validates `ctx.params` (from your router), the query string and the
 * JSON body against the given schemas; on any failure answers 400 (413 too large, 415 not JSON, 408 too slow) with
 * the field errors and never calls `handler`. A part without a schema must be empty: an unexpected query or body is
 * refused too. The handler gets the checked values as `ctx.input = { params, query, body }`.
 */
export function validated(schemas, handler, opts = {}) {
  const { body: bodySchema, query: querySchema, params: paramsSchema } = schemas ?? {};
  for (const s of [bodySchema, querySchema, paramsSchema]) if (s !== undefined) checkSchema(s); // fail at start-up, not on a request
  const wrapped = async (req, res, ctx = {}) => {
    const details = [];
    const check = (where, schema, value) => {
      if (!schema) {
        if (value !== undefined && !(kindOf(value) === "object" && Object.keys(value).length === 0)) details.push({ in: where, path: "(root)", message: "is not accepted on this route" });
        return;
      }
      for (const e of validate(schema, value)) details.push({ in: where, ...e });
    };
    let body;
    try {
      body = await readJson(req, opts);
    } catch (e) {
      if (e instanceof HttpInputError) {
        if (e.status === 413 || e.status === 408) res.on("finish", () => req.destroy());
        return send(res, e.status, { error: e.error });
      }
      throw e;
    }
    const params = coerce(paramsSchema, Object.entries(ctx.params ?? {}).map(([k, v]) => [k, [String(v)]]));
    const query = coerce(querySchema, groupQuery(req.url));
    check("params", paramsSchema, params);
    check("query", querySchema, query);
    check("body", bodySchema, body);
    if (details.length) return send(res, 400, { error: "invalid-input", details: details.slice(0, MAX_ERRORS) });
    return handler(req, res, { ...ctx, input: { params, query, body } });
  };
  Object.defineProperty(wrapped, VALIDATED, { value: true });
  return wrapped;
}

const VALIDATED = Symbol.for("devos.sm01.validated");

/** For an app test (SM-01-L1 "each route"): throws naming every route in `routes` not wrapped with `validated()`. */
export function assertAllValidated(routes) {
  const bare = Object.entries(routes).filter(([, h]) => !h?.[VALIDATED]).map(([k]) => k);
  if (bare.length) throw new Error(`routes without input validation: ${bare.join(", ")}`);
}

/**
 * Contract-test helper (SM-01-L1): invalid variants of a valid example for an object schema: each required field
 * missing, each field of the wrong type, each length/range/format/enum rule broken, and an unknown field. Each case
 * must be answered with a 4xx.
 */
export function invalidCases(schema, valid) {
  if (schema?.type !== "object") throw new Error("invalidCases: an object schema is required");
  if (validate(schema, valid).length) throw new Error("invalidCases: the example is not valid");
  const cases = [{ name: "not an object", value: [] }, { name: "unknown field", value: { ...valid, unexpected_field: 1 } }];
  for (const k of schema.required ?? []) {
    const { [k]: _omit, ...rest } = valid;
    cases.push({ name: `${k} missing`, value: rest });
  }
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const wrong = s.type === "string" ? 12345 : s.type === "boolean" ? "yes" : s.type === "array" ? "x" : s.type === "object" ? "x" : "x";
    cases.push({ name: `${k} wrong type`, value: { ...valid, [k]: wrong } });
    if (s.type === "string") {
      cases.push({ name: `${k} too long`, value: { ...valid, [k]: "a".repeat((s.maxLength ?? DEFAULT_MAX_LENGTH) + 1) } });
      if (s.minLength) cases.push({ name: `${k} too short`, value: { ...valid, [k]: "a".repeat(s.minLength - 1) } });
      if (s.enum) cases.push({ name: `${k} not allowed`, value: { ...valid, [k]: "\u0000not-in-enum" } });
      if (s.pattern) cases.push({ name: `${k} wrong format`, value: { ...valid, [k]: "\u0000" } });
    }
    if ((s.type === "integer" || s.type === "number") && s.min !== undefined) cases.push({ name: `${k} below min`, value: { ...valid, [k]: s.min - 1 } });
    if ((s.type === "integer" || s.type === "number") && s.max !== undefined) cases.push({ name: `${k} above max`, value: { ...valid, [k]: s.max + 1 } });
    if (s.type === "integer") cases.push({ name: `${k} not an integer`, value: { ...valid, [k]: 1.5 } });
    if (s.type === "array") cases.push({ name: `${k} too many items`, value: { ...valid, [k]: Array.from({ length: (s.maxItems ?? DEFAULT_MAX_ITEMS) + 1 }, () => null) } });
  }
  // Keep only cases the schema really refuses (e.g. a permissive pattern may accept the probe value).
  return cases.filter((c) => validate(schema, c.value).length > 0);
}
