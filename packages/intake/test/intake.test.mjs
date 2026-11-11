// M2.1 acceptance tests (docs/modules/M2.1.md). Fixtures are built here; no binary is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { ingest, parseSpec, IngestError, extractRequirementIds, DEFAULT_LIMITS } from "../dist/index.js";

const enc = (s) => new TextEncoder().encode(s);
const ids = (r) => r.requirementIds.map((x) => x.id);
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof IngestError, `expected IngestError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a refusal");
};

// ---------- tiny ZIP writer (stored / deflate), with knobs to forge headers ----------
function zip(files, { forge = {} } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const method = f.method ?? 8;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(f.name, "utf8");
    const crc = f.crc ?? crc32(data) >>> 0;
    const usize = f.declaredSize ?? data.length;
    const flags = f.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(forge.count ?? files.length, 8);
  eocd.writeUInt16LE(forge.count ?? files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const parts = [...locals, cd];
  if (forge.zip64) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    parts.push(loc);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (text, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const style = (id) => `<w:pStyle w:val="${id}"/>`;
const docx = (body, styles) =>
  zip([
    { name: "[Content_Types].xml", data: CT },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
    ...(styles ? [{ name: "word/styles.xml", data: `<?xml version="1.0"?><w:styles ${W}>${styles}</w:styles>` }] : []),
  ]);

// ---------- tiny PDF writer ----------
function pdf(contents, opts = {}) {
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const objs = [];
  contents.forEach((item, i) => {
    const { c, flate = true, filter } = typeof item === "string" ? { ...opts, c: item } : item;
    const raw = Buffer.from(c, "latin1");
    const data = filter ? raw : flate ? deflateSync(raw) : raw;
    const f = filter ? ` /Filter /${filter}` : flate ? " /Filter /FlateDecode" : "";
    objs.push(Buffer.concat([Buffer.from(`${i + 4} 0 obj\n<< /Length ${data.length}${f} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]));
  });
  return Buffer.concat([Buffer.from(out, "latin1"), ...objs, Buffer.from("trailer\n<< >>\n%%EOF\n", "latin1")]);
}

const SAMPLE_IDS = ["FR-001", "FR-002", "NFR-2.1", "FR-010"];

// ---------- AT1 Markdown ----------
test("AT1 markdown: headings, table, lists, code, IDs; raw script removed", () => {
  const md = [
    "Spec Title",
    "==========",
    "",
    "## FR-001 Login",
    "Users **must** sign in. See [docs](http://x).",
    "",
    "| ID | Requirement |",
    "|----|-------------|",
    "| FR-002 | Export \\| CSV |",
    "| NFR-2.1 | 99.9% uptime |",
    "",
    "- top item FR-010",
    "  - nested item",
    "1. first",
    "",
    "<script>alert(1)</script>",
    "```",
    "code <b>",
    "```",
  ].join("\n");
  const r = parseSpec(enc(md), "spec.md");
  assert.equal(r.format, "md");
  assert.deepEqual(r.blocks[0], { type: "heading", level: 1, text: "Spec Title" });
  assert.deepEqual(r.blocks[1], { type: "heading", level: 2, text: "FR-001 Login" });
  const table = r.blocks.find((b) => b.type === "table");
  assert.deepEqual(table.rows, [["ID", "Requirement"], ["FR-002", "Export | CSV"], ["NFR-2.1", "99.9% uptime"]]);
  const items = r.blocks.filter((b) => b.type === "list-item");
  assert.deepEqual(items.map((b) => [b.text, b.depth, b.ordered]), [["top item FR-010", 0, false], ["nested item", 1, false], ["first", 0, true]]);
  assert.deepEqual(ids(r), SAMPLE_IDS);
  assert.ok(!r.text.includes("alert(1)"));
  assert.ok(r.text.includes("code &lt;b&gt;"));
});

// ---------- AT2 HTML inert ----------
test("AT2 HTML with a script is stored inert", () => {
  const html = `<!doctype html><html><head><title>T</title><script>steal()</script><style>p{}</style></head>
  <body onload="evil()"><h1>Spec</h1><h2 onclick="x()">FR&#45;001 Login</h2>
  <p>Use <a href="javascript:alert(1)">this</a> &lt;script&gt;alert(2)&lt;/script&gt; text.</p>
  <img src=x onerror="alert(3)"><svg><script>alert(4)</script></svg><iframe src="https://evil"></iframe>
  <table><tr><th>ID</th><th>Req</th></tr><tr><td>FR-002</td><td>Export</td></tr><tr><td>NFR-2.1</td><td>Up</td></tr></table>
  <ul><li>FR-010 item<ul><li>nested</li></ul></li></ul>
  <SCRIPT type="text/javascript">alert(5)</SCRIPT></body></html>`;
  const r = parseSpec(enc(html), "spec.html");
  assert.equal(r.format, "html");
  for (const bad of ["<script", "<SCRIPT", "onclick", "onerror", "onload", "javascript:", "steal()", "alert(1)", "alert(3)", "alert(4)", "alert(5)", "<img", "<a "]) {
    assert.ok(!r.text.includes(bad), `output contains ${bad}`);
  }
  assert.ok(r.text.includes("&lt;script&gt;alert(2)&lt;/script&gt;"), "literal text is escaped, not markup");
  assert.deepEqual(r.blocks[0], { type: "heading", level: 1, text: "Spec" });
  assert.deepEqual(r.blocks[1], { type: "heading", level: 2, text: "FR-001 Login" });
  assert.deepEqual(r.blocks.find((b) => b.type === "table").rows, [["ID", "Req"], ["FR-002", "Export"], ["NFR-2.1", "Up"]]);
  assert.deepEqual(r.blocks.filter((b) => b.type === "list-item").map((b) => [b.text, b.depth]), [["FR-010 item", 0], ["nested", 1]]);
  assert.deepEqual(ids(r), SAMPLE_IDS);
});

// ---------- AT3 DOCX ----------
test("AT3 docx: headings, custom heading style, table, numbered list, split ID, tracked changes", () => {
  const body = [
    p("Spec Title", style("Title")),
    p("Intro", style("Heading1")),
    `<w:p><w:pPr>${style("MyHead")}</w:pPr><w:r><w:t>FR-</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>001</w:t></w:r><w:r><w:t xml:space="preserve"> Login</w:t></w:r></w:p>`,
    `<w:tbl><w:tr><w:tc>${p("ID")}</w:tc><w:tc>${p("Req")}</w:tc></w:tr><w:tr><w:tc>${p("FR-002")}</w:tc><w:tc>${p("Export &amp; share")}</w:tc></w:tr><w:tr><w:tc>${p("NFR-2.1")}</w:tc><w:tc>${p("a")}${p("b")}</w:tc></w:tr></w:tbl>`,
    p("FR-010 item", `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>`),
    p("child", `<w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr>`),
    `<w:p><w:r><w:t>kept </w:t></w:r><w:del w:id="1"><w:r><w:delText>FR-999 gone</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>`,
    `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:noBreakHyphen/><w:t>c</w:t></w:r></w:p>`,
  ].join("");
  const styles = `<w:style w:type="paragraph" w:styleId="MyHead"><w:name w:val="heading 2"/></w:style>`;
  const r = parseSpec(docx(body, styles), "spec.docx");
  assert.equal(r.format, "docx");
  assert.deepEqual(r.blocks.slice(0, 3), [
    { type: "heading", level: 1, text: "Spec Title" },
    { type: "heading", level: 1, text: "Intro" },
    { type: "heading", level: 2, text: "FR-001 Login" },
  ]);
  assert.deepEqual(r.blocks.find((b) => b.type === "table").rows, [["ID", "Req"], ["FR-002", "Export & share"], ["NFR-2.1", "a b"]]);
  assert.deepEqual(r.blocks.filter((b) => b.type === "list-item").map((b) => [b.text, b.depth, b.ordered]), [["FR-010 item", 0, true], ["child", 1, true]]);
  assert.ok(r.blocks.some((b) => b.text === "kept inserted"));
  assert.ok(r.blocks.some((b) => b.text === "a b-c"));
  assert.deepEqual(ids(r), SAMPLE_IDS);
  assert.ok(!r.text.includes("FR-999"));
  assert.deepEqual(r.warnings, ["docx-tracked-deletions-skipped"]);
  assert.ok(r.text.includes("Export &amp; share"), "rendered text is escaped");
});

// ---------- AT4 PDF ----------
test("AT4 pdf: Flate + plain streams, Tj/TJ, IDs; no text refused; unsupported filter warns", () => {
  const c1 = "BT /F1 12 Tf 72 720 Td (Spec Title) Tj 0 -14 Td [(FR-0)-10(01 Lo)5(gin)] TJ T* (FR-002 Export \\(CSV\\)) Tj ET";
  const c2 = "BT 72 600 Td <4E46522D322E31> Tj ( uptime) Tj ET BT 1 0 0 1 72 580 Tm [(FR-010)-300(item)] TJ ET";
  const doc = pdf([c1, { c: c2, flate: false }]);
  const r = parseSpec(doc, "spec.pdf");
  assert.equal(r.format, "pdf");
  const lines = r.blocks.map((b) => b.text);
  assert.deepEqual(lines, ["Spec Title", "FR-001 Login", "FR-002 Export (CSV)", "NFR-2.1 uptime", "FR-010 item"]);
  assert.deepEqual(ids(r), SAMPLE_IDS);
  assert.equal(code(() => parseSpec(pdf(["q 1 0 0 1 0 0 cm Q"]), "scan.pdf")), "pdf-no-text");
  const w = parseSpec(pdf([c1, { c: "BT (x) Tj ET", filter: "DCTDecode" }]), "mixed.pdf");
  assert.ok(w.warnings.includes("pdf-filter-unsupported"));
  const cid = parseSpec(pdf([c1 + " BT <00240025> Tj ET"]), "cid.pdf");
  assert.ok(cid.warnings.includes("pdf-text-encoding"));
});

// ---------- AT5 renamed binaries ----------
test("AT5 a renamed binary is rejected", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.from("<html>")]);
  const someZip = zip([{ name: "a.txt", data: "hello" }]);
  const aPdf = pdf(["BT (FR-1) Tj ET"]);
  assert.equal(code(() => parseSpec(png, "spec.md")), "type-mismatch");
  assert.equal(code(() => parseSpec(elf, "spec.html")), "type-mismatch");
  assert.equal(code(() => parseSpec(someZip, "spec.pdf")), "type-mismatch");
  assert.equal(code(() => parseSpec(aPdf, "spec.docx")), "type-mismatch");
  assert.equal(code(() => parseSpec(someZip, "spec.docx")), "type-mismatch");
  assert.equal(code(() => parseSpec(enc("MZ\x90\x00"), "spec.txt")), "type-mismatch");
  assert.equal(code(() => parseSpec(Buffer.from([0x61, 0xff, 0xfe, 0x62]), "spec.md")), "text-not-utf8");
  assert.equal(code(() => parseSpec(enc("hi"), "setup.exe")), "type-unknown");
  assert.equal(code(() => parseSpec(enc("hi"), "noext")), "type-unknown");
});

// ---------- AT6 oversize ----------
test("AT6 an oversize file is rejected before parsing; empty is refused", () => {
  assert.equal(DEFAULT_LIMITS.maxBytes, 10 * 1024 * 1024);
  const big = Buffer.alloc(DEFAULT_LIMITS.maxBytes + 1, 0x41);
  assert.equal(code(() => parseSpec(big, "spec.md")), "too-large");
  // Over a lower cap, even with contents that would not parse (proves the check runs first).
  assert.equal(code(() => parseSpec(Buffer.alloc(2048, 0x00), "spec.docx", { limits: { maxBytes: 1024 } })), "too-large");
  assert.equal(code(() => parseSpec(new Uint8Array(0), "spec.md")), "empty");
  assert.doesNotThrow(() => parseSpec(Buffer.alloc(DEFAULT_LIMITS.maxBytes, 0x41), "spec.md"));
});

// ---------- AT7 archive bombs ----------
test("AT7 docx archive-bomb and ZIP limits", () => {
  const ok = (body = p("FR-1")) => ({ name: "word/document.xml", data: `<w:document ${W}><w:body>${body}</w:body></w:document>` });
  const ct = { name: "[Content_Types].xml", data: CT };
  // Ratio > 100:1 on a > 1 MiB entry.
  const bomb = Buffer.alloc(5 * 1024 * 1024, 0x20);
  assert.equal(code(() => parseSpec(zip([ct, ok(), { name: "word/media/x.bin", data: bomb }]), "b.docx")), "archive-bomb");
  // Too many entries.
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: "x", method: 0 }));
  assert.equal(code(() => parseSpec(zip([ct, ok(), ...many]), "m.docx", { limits: { maxZipEntries: 20 } })), "archive-bomb");
  // Declared total over the cap.
  assert.equal(code(() => parseSpec(zip([ct, ok(), { name: "x", data: "y", declaredSize: 200 * 1024 * 1024 }]), "t.docx")), "archive-bomb");
  // An entry whose real inflated size exceeds its header.
  const doc = ok(p("FR-1 ".repeat(200)));
  assert.equal(code(() => parseSpec(zip([ct, { ...doc, declaredSize: 50 }]), "lie.docx")), "archive-bomb");
  // CRC mismatch.
  assert.equal(code(() => parseSpec(zip([ct, { ...ok(), crc: 1234 }]), "crc.docx")), "zip-corrupt");
  // Encrypted, ZIP64, unsupported method.
  assert.equal(code(() => parseSpec(zip([ct, { ...ok(), flags: 1 }]), "enc.docx")), "zip-unsupported");
  assert.equal(code(() => parseSpec(zip([ct, ok()], { forge: { zip64: true } }), "z64.docx")), "zip-unsupported");
  assert.equal(code(() => parseSpec(zip([ct, { ...ok(), method: 12 }]), "bz.docx")), "zip-unsupported");
  // Truncated archive.
  const good = zip([ct, ok()]);
  assert.equal(code(() => parseSpec(good.subarray(0, good.length - 10), "cut.docx")), "zip-corrupt");
  // And the good one parses.
  assert.deepEqual(ids(parseSpec(good, "good.docx")), ["FR-1"]);
});

// ---------- AT8 worker sandbox ----------
test("AT8 ingest parses in a worker; timeout terminates it", async () => {
  const bytes = docx(p("Title", style("Heading1")) + p("FR-001 text"));
  const inProc = parseSpec(bytes, "spec.docx");
  const viaWorker = await ingest(bytes, "spec.docx");
  assert.deepEqual(viaWorker, inProc);
  await assert.rejects(ingest(bytes, "spec.docx", { limits: { parseTimeoutMs: 1 } }), (e) => e instanceof IngestError && e.code === "parse-timeout");
  // Refusals cross back as fixed codes.
  await assert.rejects(ingest(pdf(["q Q"]), "s.pdf"), (e) => e instanceof IngestError && e.code === "pdf-no-text");
  // Prechecks run in the caller, before any worker.
  await assert.rejects(ingest(enc("x"), "s.md", { limits: { maxBytes: 0.5 } }), (e) => e.code === "too-large");
  // The process is healthy afterwards.
  assert.deepEqual(ids(await ingest(enc("# FR-5"), "a.md")), ["FR-5"]);
});

// ---------- AT9 requirement ID rules ----------
test("AT9 requirement ID rules, and the same IDs from all four formats", () => {
  const found = extractRequirementIds("FR-001, NFR-2.1; FR12 and REQ-7. Also FR-001 again (FR-3.10).").map((x) => x.id);
  assert.deepEqual(found, ["FR-001", "NFR-2.1", "FR12", "REQ-7", "FR-3.10"]);
  assert.equal(extractRequirementIds("FR-001 FR-001").find((x) => x.id === "FR-001").count, 2);
  for (const not of ["SHA-256", "UTF-8", "ISO-8601", "XFR-1", "FRX-1", "fr-1", "FR-", "FR-1a", "v.FR-1", "AFR12"]) {
    assert.deepEqual(extractRequirementIds(not), [], not);
  }
  assert.deepEqual(extractRequirementIds("PR-4 FR-4", ["PR"]).map((x) => x.id), ["PR-4"]);
  assert.throws(() => extractRequirementIds("x", ["bad prefix"]));

  const lines = ["FR-001 Login", "FR-002 Export", "NFR-2.1 Uptime", "FR-010 Item"];
  const md = parseSpec(enc(lines.map((l) => `- ${l}`).join("\n")), "s.md");
  const html = parseSpec(enc(`<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`), "s.html");
  const dx = parseSpec(docx(lines.map((l) => p(l)).join("")), "s.docx");
  const pd = parseSpec(pdf([`BT ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`]), "s.pdf");
  for (const r of [md, html, dx, pd]) assert.deepEqual(ids(r), SAMPLE_IDS, r.format);
});

// ---------- AT10 spec row + error hygiene ----------
test("AT10 specRow and error hygiene", () => {
  const bytes = enc("# FR-1 secret-ish heading");
  const r = parseSpec(bytes, "../../etc/\u0007My Spec.md");
  assert.deepEqual(Object.keys(r.specRow).sort(), ["fileSha256", "originalName", "sourceFormat", "text"]);
  assert.equal(r.specRow.sourceFormat, "md");
  assert.equal(r.specRow.originalName, "My Spec.md");
  assert.equal(r.specRow.fileSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.specRow.text, r.text);
  assert.equal(parseSpec(enc("x"), "a".repeat(400) + ".md").specRow.originalName.length, 255);
  for (const [b, n] of [[Buffer.from([0x89, 0x50, 0x4e, 0x47]), "TOPSECRET.md"], [pdf(["q Q"]), "TOPSECRET.pdf"]]) {
    try {
      parseSpec(b, n);
    } catch (e) {
      assert.ok(!String(e.message).includes("TOPSECRET"));
      assert.ok(!String(e.stack ?? "").includes("TOPSECRET"));
    }
  }
});
