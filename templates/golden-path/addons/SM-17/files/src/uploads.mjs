// SM-17 add-on: files and uploads (docs/modules/S3.md, "S3-d4 SM-17 build notes").
// SM-17-L1: a renamed binary is rejected; an oversize file is rejected; stored names are random and outside the
// web root.
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class UploadError extends Error {
  constructor(code, message) { super(message); this.name = "UploadError"; this.code = code; }
}

export const DEFAULT_MAX_BYTES = 10_000_000;

// The file's first bytes decide its type; the name and the client's content type never do.
const TYPES = {
  png: { ext: "png", mime: "image/png", test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpeg: { ext: "jpg", mime: "image/jpeg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { ext: "gif", mime: "image/gif", test: (b) => b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  webp: { ext: "webp", mime: "image/webp", test: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  pdf: { ext: "pdf", mime: "application/pdf", test: (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
};
const EXT_OF_NAME = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", pdf: "pdf" };

/** sniffType(bytes) -> "png" | "jpeg" | "gif" | "webp" | "pdf" | null, from the magic bytes only. */
export function sniffType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  for (const [k, t] of Object.entries(TYPES)) if (t.test(bytes)) return k;
  return null;
}

/**
 * checkUpload({ name, bytes, allow = ["png", "jpeg", "gif", "webp", "pdf"], maxBytes }) -> { type, ext, mime, size }
 * Refuses (UploadError): empty, too-large, type-not-allowed (unknown or not in allow), name-mismatch (the name's
 * extension says another type: a renamed file).
 */
export function checkUpload({ name, bytes, allow = Object.keys(TYPES), maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("checkUpload: maxBytes must be a positive integer");
  if (!Array.isArray(allow) || allow.some((a) => !Object.hasOwn(TYPES, a))) throw new TypeError(`checkUpload: allow may name only ${Object.keys(TYPES).join(", ")}`);
  if (!Buffer.isBuffer(bytes)) throw new UploadError("empty", "no file");
  if (bytes.length === 0) throw new UploadError("empty", "the file is empty");
  if (bytes.length > maxBytes) throw new UploadError("too-large", `the file is over ${maxBytes} bytes`);
  const type = sniffType(bytes);
  if (!type || !allow.includes(type)) throw new UploadError("type-not-allowed", "this kind of file is not accepted");
  const m = typeof name === "string" ? name.toLowerCase().match(/\.([a-z0-9]{1,8})$/) : null;
  if (m && EXT_OF_NAME[m[1]] !== type) throw new UploadError("name-mismatch", "the file's name does not match its contents");
  return { type, ext: TYPES[type].ext, mime: TYPES[type].mime, size: bytes.length };
}

/**
 * readBody(req, maxBytes) -> Buffer. Reads a request body and stops at the cap: a declared Content-Length over the
 * cap is refused before reading, and a body that grows past it is cut and refused (UploadError "too-large").
 */
export function readBody(req, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers && req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) { req.resume(); reject(new UploadError("too-large", `the file is over ${maxBytes} bytes`)); return; }
    const chunks = []; let n = 0, done = false;
    req.on("data", (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) { done = true; req.pause(); reject(new UploadError("too-large", `the file is over ${maxBytes} bytes`)); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolveBody(Buffer.concat(chunks)); } });
    req.on("error", () => { if (!done) { done = true; reject(new UploadError("read-failed", "the upload did not complete")); } });
  });
}

const ID = /^[0-9a-f]{32}\.(png|jpg|gif|webp|pdf)$/;

/**
 * createStore({ dir, webRoot }) -> { save(bytes, checked) -> id, path(id), read(id) }
 * dir is where files go: an absolute path that is not inside webRoot (the folder the app serves, default
 * <cwd>/public), so a stored file is never served directly. Names are 128 random bits plus the sniffed extension;
 * the user's name is never used. Files are written once (no overwrite) and readable by the app's user only.
 */
export function createStore({ dir, webRoot = resolve("public") } = {}) {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new TypeError("createStore: dir must be an absolute path");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  let web; try { web = realpathSync(webRoot); } catch { web = resolve(webRoot); }
  const rel = relative(web, real);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);   // "..x" is a folder inside
  if (!outside) throw new TypeError("createStore: dir must be outside the web root");
  const path = (id) => {
    if (typeof id !== "string" || !ID.test(id)) throw new UploadError("not-found", "no such file");
    return join(real, id);
  };
  return {
    dir: real,
    save(bytes, checked) {
      if (!checked || !Object.hasOwn(TYPES, checked.type) || checked.size !== bytes.length || sniffType(bytes) !== checked.type) {
        throw new TypeError("save: pass the bytes and the result of checkUpload for them");
      }
      const id = `${randomBytes(16).toString("hex")}.${checked.ext}`;
      writeFileSync(path(id), bytes, { flag: "wx", mode: 0o600 });
      return id;
    },
    path,
    read(id) {
      try { return readFileSync(path(id)); } catch (e) { if (e instanceof UploadError) throw e; throw new UploadError("not-found", "no such file"); }
    },
  };
}
