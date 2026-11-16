// SM-17-L1: a renamed binary is rejected; an oversize file is rejected; stored names are random and outside the
// web root.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync, rmSync, statSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkUpload, createStore, readBody, sniffType, UploadError } from "../src/uploads.mjs";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from("%PDF-1.7\n%...");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]);   // a Linux program
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(32)]);                       // a Windows program
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

let root;
before(() => { root = mkdtempSync(join(tmpdir(), "sm17-")); });
after(() => rmSync(root, { recursive: true, force: true }));
const code = (c) => (e) => { assert.ok(e instanceof UploadError, String(e)); assert.equal(e.code, c, e.message); return true; };

test("SM-17-L1 type: the magic bytes decide; a renamed binary is rejected", () => {
  assert.equal(sniffType(PNG), "png"); assert.equal(sniffType(JPEG), "jpeg"); assert.equal(sniffType(PDF), "pdf");
  assert.equal(checkUpload({ name: "photo.PNG", bytes: PNG }).type, "png");
  assert.equal(checkUpload({ name: "scan.jpeg", bytes: JPEG }).ext, "jpg");
  assert.equal(checkUpload({ name: "no-extension", bytes: PDF }).mime, "application/pdf");
  for (const [name, bytes] of [["photo.png", ELF], ["photo.jpg", EXE], ["report.pdf", HTML], ["logo.png", SVG], ["page.png", Buffer.from("plain text")]]) {
    assert.throws(() => checkUpload({ name, bytes }), code("type-not-allowed"), name);   // a program or page renamed as an allowed type
  }
  for (const [name, bytes] of [["invoice.pdf", PNG], ["photo.png", JPEG], ["run.exe", PNG], ["page.html", PNG], ["x.svg", PNG]]) {
    assert.throws(() => checkUpload({ name, bytes }), code("name-mismatch"), name);      // an allowed type under another type's name
  }
  assert.throws(() => checkUpload({ name: "a.pdf", bytes: PDF, allow: ["png"] }), code("type-not-allowed"), "not in this app's allow-list");
  assert.throws(() => checkUpload({ bytes: PNG, allow: ["svg"] }), TypeError);
});

test("SM-17-L1 size: an empty or oversize file is rejected, in memory and while the body is read", async () => {
  assert.throws(() => checkUpload({ name: "a.png", bytes: Buffer.alloc(0) }), code("empty"));
  assert.throws(() => checkUpload({ name: "a.png", bytes: "not bytes" }), code("empty"));
  assert.throws(() => checkUpload({ name: "a.png", bytes: Buffer.concat([PNG, Buffer.alloc(100)]), maxBytes: 100 }), code("too-large"));
  assert.equal(checkUpload({ name: "a.png", bytes: PNG, maxBytes: PNG.length }).size, PNG.length, "exactly at the cap passes");
  assert.throws(() => checkUpload({ bytes: PNG, maxBytes: 0 }), TypeError);

  const srv = http.createServer(async (req, res) => {
    try { const b = await readBody(req, 1000); res.end(`ok ${b.length}`); }
    catch (e) { res.writeHead(e.code === "too-large" ? 413 : 400, { connection: "close" }); res.end(e.code); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const send = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", headers, agent: false }, (res) => {
      let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve([res.statusCode, t]));
    });
    req.on("error", reject);
    if (typeof body === "function") body(req); else req.end(body);
  });
  try {
    assert.deepEqual(await send(Buffer.alloc(1000)), [200, "ok 1000"]);
    assert.deepEqual(await send(Buffer.alloc(1001)), [413, "too-large"], "declared length over the cap");
    // No declared length: the body grows past the cap in chunks and is cut.
    const [status] = await send((req) => { req.write(Buffer.alloc(600)); setTimeout(() => req.end(Buffer.alloc(600)), 20); }, { "transfer-encoding": "chunked" });
    assert.equal(status, 413, "a chunked body over the cap");
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("SM-17-L1 storage: names are random, never the user's, and the folder is outside the web root", () => {
  const app = join(root, "app"); mkdirSync(join(app, "public"), { recursive: true });
  const web = join(app, "public");
  const store = createStore({ dir: join(root, "data", "uploads"), webRoot: web });
  const ids = new Set();
  for (let i = 0; i < 20; i++) ids.add(store.save(PNG, checkUpload({ name: "../../public/index.html.png", bytes: PNG })));
  assert.equal(ids.size, 20, "every save gets a new name");
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{32}\.png$/, "128 random bits and the sniffed extension, nothing from the user's name");
    assert.equal(dirname(store.path(id)), store.dir);
    assert.ok(!store.path(id).startsWith(web), "outside the web root");
    assert.equal(statSync(store.path(id)).mode & 0o077, 0, "readable by the app's user only");
  }
  assert.deepEqual(readdirSync(web), [], "nothing written under the web root");
  assert.ok(store.read([...ids][0]).equals(PNG));
  for (const bad of ["../../etc/passwd", "a".repeat(32) + ".html", `${"a".repeat(32)}.png/../x`, "", null, "A".repeat(32) + ".png"]) {
    assert.throws(() => store.read(bad), code("not-found"), String(bad));
  }
  assert.throws(() => store.read("b".repeat(32) + ".png"), code("not-found"), "a well-formed name that was never stored");
  // The store refuses a folder inside the web root, the web root itself, a link into it, and a relative path.
  assert.throws(() => createStore({ dir: join(web, "uploads"), webRoot: web }), TypeError);
  assert.deepEqual(readdirSync(web), [], "a refused folder is not created under the web root");
  assert.throws(() => createStore({ dir: web, webRoot: web }), TypeError);
  symlinkSync(web, join(root, "link-to-web"));
  assert.throws(() => createStore({ dir: join(root, "link-to-web", "up"), webRoot: web }), TypeError);
  assert.deepEqual(readdirSync(web), [], "nor through a link");
  assert.throws(() => createStore({ dir: "data/uploads", webRoot: web }), TypeError);
  assert.throws(() => createStore({ dir: join(web, "..x"), webRoot: web }), TypeError, "a folder inside whose name starts with ..");
  assert.ok(createStore({ dir: join(app, "uploads"), webRoot: web }), "a sibling of the web root is fine");
  // An existing folder is tightened to owner-only.
  const open = join(root, "open"); mkdirSync(open, { mode: 0o777 }); chmodSync(open, 0o777);
  createStore({ dir: open, webRoot: web });
  assert.equal(statSync(open).mode & 0o077, 0, "an existing upload folder is made owner-only");
  // The stored extension comes from the sniffed type, never from the caller.
  assert.match(store.save(PNG, { type: "png", ext: "pdf", size: PNG.length }), /\.png$/);
  // save() refuses bytes whose type or size do not match the check passed with them.
  assert.throws(() => store.save(ELF, { type: "png", ext: "png", size: ELF.length }), TypeError);
  assert.throws(() => store.save(PNG), TypeError);
});
