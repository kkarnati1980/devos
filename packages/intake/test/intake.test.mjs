// M2.1 acceptance tests (docs/modules/M2.1.md). Fixtures are built here; no binary is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  assert.ok(r.text.includes("&lt;script&gt;alert\\(2\\)&lt;/script&gt;"), "literal text is escaped, not markup");
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
  // PR30-r1: no digit-count limit; a long dotted run is matched without backtracking blow-up.
  assert.deepEqual(extractRequirementIds("FR-123456 and NFR-1.12345.").map((x) => x.id), ["FR-123456", "NFR-1.12345"]);
  const t0 = Date.now();
  assert.deepEqual(extractRequirementIds("FR-" + "1.".repeat(20000) + "1a").length, 0);
  assert.ok(Date.now() - t0 < 2000, "no catastrophic backtracking");
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

// ---------- PR30-r1: Markdown-inert output ----------
test("AT2b output is inert as Markdown: no image, link, reference or emphasis can form", () => {
  const html = `<p>![tracking](https://example.com/pixel)</p><p>[click](javascript:alert%281%29)</p>
  <p>[ref]: https://evil.example</p><p>**bold** _em_ ~~s~~ \`code\` $x$ [^1]</p><p># not a heading</p><p>- not a list</p><p>1. not a list</p>
  <pre>\`\`\`\nbreak out?\n\`\`\`\n![x](y)</pre>`;
  const r = parseSpec(enc(html), "s.html");
  for (const bad of ["![tracking](", "[click](", "\n[ref]:", "**bold**", "_em_", "~~s~~", "`code`", "$x$", "[^1]", "\n# not", "\n- not", "\n1. not"]) {
    assert.ok(!r.text.includes(bad), `Markdown construct survives: ${JSON.stringify(bad)}`);
  }
  assert.ok(r.text.includes("\\!\\[tracking\\]\\(https://example.com/pixel\\)"));
  // The code block cannot be closed from inside: its fence is longer than any backtick run in it.
  const code = r.blocks.find((b) => b.type === "code");
  assert.ok(code && code.text.includes("![x](y)"));
  assert.ok(r.text.includes("````\n```"), "fence longer than the content's backtick runs");
  // Plain blocks keep their text (only the rendered Markdown is escaped).
  assert.equal(r.blocks[0].text, "![tracking](https://example.com/pixel)");
});

// ---------- PR30-r1: PDF page order from the page tree ----------
function pdfObjects(objs, rootNum) {
  let out = Buffer.from("%PDF-1.7\n", "latin1");
  for (const [num, body] of objs) {
    const part = typeof body === "string" ? `${num} 0 obj\n${body}\nendobj\n` : null;
    if (part) out = Buffer.concat([out, Buffer.from(part, "latin1")]);
    else {
      const data = deflateSync(Buffer.from(body.stream, "latin1"));
      out = Buffer.concat([out, Buffer.from(`${num} 0 obj\n<< ${body.dict ?? ""} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    }
  }
  return Buffer.concat([out, Buffer.from(`trailer\n<< /Root ${rootNum} 0 R >>\n%%EOF\n`, "latin1")]);
}

test("AT4b pdf follows the page tree: physical order and unused or obsolete streams do not matter", () => {
  const doc = pdfObjects(
    [
      [9, { stream: "BT (FR-002 page two) Tj ET" }], // page 2's content first in the file
      [8, { stream: "BT (FR-999 obsolete) Tj ET" }], // referenced by nothing
      [7, { stream: "BT (FR-001 page one) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>"],
      [4, "<< /Type /Page /Parent 2 0 R /Contents [9 0 R] >>"],
    ],
    1,
  );
  const r = parseSpec(doc, "tree.pdf");
  assert.deepEqual(r.blocks.map((b) => b.text), ["FR-001 page one", "FR-002 page two"]);
  assert.deepEqual(ids(r), ["FR-001", "FR-002"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));

  // Incremental update: object 7 redefined later; the newer text wins.
  const updated = Buffer.concat([doc, pdfObjects([[7, { stream: "BT (FR-001 revised) Tj ET" }]], 1).subarray(9)]);
  assert.deepEqual(parseSpec(updated, "upd.pdf").blocks.map((b) => b.text), ["FR-001 revised", "FR-002 page two"]);

  // Page dictionaries inside an object stream (/Type /ObjStm).
  const packed = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>"];
  let off = 0;
  const head = [];
  for (const [i, body] of packed.entries()) {
    head.push(`${i + 1} ${off}`);
    off += body.length + 1;
  }
  const headStr = head.join(" ") + " ";
  const objStm = { dict: `/Type /ObjStm /N 3 /First ${headStr.length}`, stream: headStr + packed.join("\n") + "\n" };
  const viaObjStm = pdfObjects([[7, { stream: "BT (FR-005 packed) Tj ET" }], [10, objStm]], 1);
  assert.deepEqual(ids(parseSpec(viaObjStm, "objstm.pdf")), ["FR-005"]);

  // Without a resolvable page tree, file order is used and the result says so.
  assert.ok(parseSpec(pdf(["BT (FR-1) Tj ET"]), "flat.pdf").warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r2 ----------
test("AT1b a fenced <script> example never removes later requirements", () => {
  const md = ["# Spec", "```html", "<script>", "example();", "```", "", "- FR-001 still here", "<script>unclosed", "- FR-002 also here", "<style>p{}</style>", "- FR-003 kept"].join("\n");
  const r = parseSpec(enc(md), "s.md");
  assert.deepEqual(ids(r), ["FR-001", "FR-002", "FR-003"]);
  const code = r.blocks.find((b) => b.type === "code");
  assert.equal(code.text, "<script>\nexample();");
  assert.ok(!r.text.includes("<script"), "nothing active in the output");
  assert.ok(!r.text.includes("p{}"), "closed style block removed");
});

test("AT10b check-spec CLI: unreadable input is a fixed refusal with no path", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const secretPath = "/nonexistent/TOPSECRET-dir/spec.md";
  let out = "";
  let status = 0;
  try {
    execFileSync(process.execPath, [cli, secretPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String(e.stdout) + String(e.stderr);
    status = e.status;
  }
  assert.equal(status, 2);
  assert.equal(out.trim(), "refused: file-unreadable");
  assert.ok(!out.includes("TOPSECRET"));
});

// ---------- PR30-r3 ----------
test("AT1c a closing fence needs only whitespace after it; a longer or info-string line does not close", () => {
  const md = ["```html", "```example", "<script>FR-001</script>", "```", "", "````", "```", "FR-002 inside", "````  ", "- FR-003 after"].join("\n");
  const r = parseSpec(enc(md), "s.md");
  const codes = r.blocks.filter((b) => b.type === "code").map((b) => b.text);
  assert.deepEqual(codes, ["```example\n<script>FR-001</script>", "```\nFR-002 inside"]);
  assert.deepEqual(ids(r), ["FR-001", "FR-002", "FR-003"]);
  assert.ok(!r.text.includes("<script"), "code is HTML-escaped in the rendered text");
});

test("AT4c pdf: an indirect /Kids array resolves; an unknown leaf falls back to file order", () => {
  const doc = pdfObjects(
    [
      [7, { stream: "BT (FR-001 via indirect kids) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids 5 0 R /Count 1 >>"],
      [5, "[3 0 R]"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>"],
    ],
    1,
  );
  const r = parseSpec(doc, "kids.pdf");
  assert.deepEqual(ids(r), ["FR-001"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));
  const odd = pdfObjects(
    [
      [7, { stream: "BT (FR-002 orphan) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] >>"],
      [3, "<< /Type /Mystery >>"],
    ],
    1,
  );
  const o = parseSpec(odd, "odd.pdf");
  assert.deepEqual(ids(o), ["FR-002"]);
  assert.ok(o.warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r4 ----------
test("AT4d a page whose text mentions begincmap is kept; a real CMap stream is skipped in file order", () => {
  const doc = pdfObjects(
    [
      [7, { stream: "BT (FR-001 Document the begincmap operator) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>"],
    ],
    1,
  );
  assert.deepEqual(ids(parseSpec(doc, "word.pdf")), ["FR-001"]);
  const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 beginbfchar <01> <0046> endbfchar endcmap end end BT (FR-998) Tj ET";
  const flat = parseSpec(pdf(["BT (FR-002 begincmap in text) Tj ET", cmap]), "flat.pdf");
  assert.deepEqual(ids(flat), ["FR-002"]);
});

test("AT6b huge single blocks within the limits render (no argument-spread RangeError)", () => {
  const code = "```\n" + "` ".repeat(500_000) + "\n```";
  const r = parseSpec(enc(code), "big.md");
  assert.equal(r.blocks.length, 1);
  assert.ok(r.text.startsWith("```\n` ` "));
  const rows = Array.from({ length: 200_000 }, (_, i) => `<tr><td>R${i}</td></tr>`).join("");
  const t = parseSpec(enc(`<table>${rows}</table>`), "rows.html");
  assert.equal(t.blocks[0].rows.length, 200_000);
});

// ---------- PR30-r5 ----------
test("AT4e stream boundaries: indirect /Length is resolved; 'endstream' in a text string does not cut the stream", () => {
  const content = "BT (FR-001) Tj T* (Document endstream for FR-002) Tj T* (and endstream endobj FR-003) Tj ET";
  const build = (lengthEntry, extra = "") =>
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
        `4 0 obj\n<< ${lengthEntry} >>\nstream\n${content}\nendstream\nendobj\n` +
        extra +
        "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
      "latin1",
    );
  const viaIndirect = parseSpec(build("/Length 9 0 R", `9 0 obj\n${content.length}\nendobj\n`), "ind.pdf");
  assert.deepEqual(ids(viaIndirect), ["FR-001", "FR-002", "FR-003"]);
  const viaDirect = parseSpec(build(`/Length ${content.length}`), "dir.pdf");
  assert.deepEqual(ids(viaDirect), ["FR-001", "FR-002", "FR-003"]);
  // No usable length (dangling reference, or none at all): the text stream is scanned past its strings.
  assert.deepEqual(ids(parseSpec(build("/Length 9 0 R"), "dangling.pdf")), ["FR-001", "FR-002", "FR-003"]);
  assert.deepEqual(ids(parseSpec(build("/Length 999999"), "wrong.pdf")), ["FR-001", "FR-002", "FR-003"]);
});

// ---------- PR30-r6 ----------
test("AT4f object boundaries and structure lookups skip strings and comments", () => {
  const doc = pdfObjects(
    [
      [7, { stream: "BT (FR-001 page one) Tj ET" }],
      [8, { stream: "BT (FR-002 page two) Tj ET" }],
      [9, { stream: "BT (FR-666 decoy) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R /Note (/Root 5 0 R) >>"],
      [2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Note (endobj stream\n) /Contents 7 0 R >>"],
      [4, "<< /Type /Page /Parent 2 0 R /Alt (/Contents 9 0 R) % endobj /Contents 9 0 R\n /Contents 8 0 R >>"],
    ],
    1,
  );
  const r = parseSpec(doc, "strings.pdf");
  assert.deepEqual(r.blocks.map((b) => b.text), ["FR-001 page one", "FR-002 page two"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r7 ----------
test("AT4g the latest Root wins across trailers and xref streams; fake trailers inside objects are ignored", () => {
  const base = pdfObjects(
    [
      [7, { stream: "BT (FR-001 old catalog) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>"],
      [20, "<< /Info (trailer << /Root 30 0 R >>) >>"],
    ],
    1,
  );
  const update = Buffer.from(
    "10 0 obj\n<< /Type /Catalog /Pages 12 0 R >>\nendobj\n" +
      "12 0 obj\n<< /Type /Pages /Kids [13 0 R] >>\nendobj\n" +
      "13 0 obj\n<< /Type /Page /Parent 12 0 R /Contents 14 0 R >>\nendobj\n" +
      "14 0 obj\n<< /Length 29 >>\nstream\nBT (FR-010 current one) Tj ET\nendstream\nendobj\n" +
      "15 0 obj\n<< /Type /XRef /Root 10 0 R /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n0\n%%EOF\n",
    "latin1",
  );
  const r = parseSpec(Buffer.concat([base, update]), "incr.pdf");
  assert.deepEqual(ids(r), ["FR-010"]);
  // Without the update, the conventional trailer's Root is used and the fake one inside object 20 is not.
  assert.deepEqual(ids(parseSpec(base, "base.pdf")), ["FR-001"]);
});

test("AT4h file-order fallback reads only real stream objects, never stream-like text inside strings", () => {
  const doc = pdfObjects(
    [
      [5, "<< /Title (5 0 obj << >> stream\nBT (FR-999) Tj ET\nendstream\nendobj) >>"],
      [6, { stream: "BT (FR-001 real) Tj ET" }],
    ],
    99,
  );
  const r = parseSpec(doc, "meta.pdf");
  assert.deepEqual(ids(r), ["FR-001"]);
  assert.ok(r.warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r8 ----------
test("AT4i comments between objects never create objects or trailers", () => {
  const doc = Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
      "% 999 0 obj\n" +
      "4 0 obj\n<< /Length 22 >>\nstream\nBT (FR-001 four) Tj ET\nendstream\nendobj\n" +
      "5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>\nendobj\n" +
      "6 0 obj\n<< /Length 21 >>\nstream\nBT (FR-002 six) Tj ET\nendstream\nendobj\n" +
      "% trailer << /Root 77 0 R >>\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "latin1",
  );
  const r = parseSpec(doc, "comments.pdf");
  assert.deepEqual(ids(r), ["FR-001", "FR-002"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r9 ----------
test("AT2c paragraphs, divs and line breaks inside an HTML table cell keep their text apart", () => {
  const r = parseSpec(enc("<table><tr><td><p>FR-1</p><p>FR-2</p></td><td><div>FR-3</div><div>FR-4</div>FR-5<br>FR-6</td></tr></table>"), "t.html");
  assert.deepEqual(ids(r), ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6"]);
  assert.deepEqual(r.blocks[0].rows, [["FR-1 FR-2", "FR-3 FR-4 FR-5 FR-6"]]);
});

test("AT4j PDF name tokens such as /endobj and /stream never end an object", () => {
  const doc = pdfObjects(
    [
      [4, { stream: "BT (FR-001 named) Tj ET" }],
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Custom /endobj /Other /stream\n /Contents 4 0 R >>"],
    ],
    1,
  );
  const r = parseSpec(doc, "names.pdf");
  assert.deepEqual(ids(r), ["FR-001"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));
});

// ---------- PR30-r10 ----------
test("AT4k a multi-digit indirect /Length is resolved, also for a Flate stream whose bytes contain 'endstream endobj'", () => {
  const content = "BT (FR-001 before) Tj T* (text: endstream endobj) Tj T* (FR-002 after) Tj ET";
  const data = deflateSync(Buffer.from(content, "latin1"), { level: 0 }); // stored blocks: the text appears verbatim
  assert.ok(data.includes(Buffer.from("endstream endobj")), "fixture really contains the delimiter text");
  const doc = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
        "4 0 obj\n<< /Length 19 0 R /Filter /FlateDecode >>\nstream\n",
      "latin1",
    ),
    data,
    Buffer.from(`\nendstream\nendobj\n19 0 obj\n${data.length}\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1"),
  ]);
  const r = parseSpec(doc, "len19.pdf");
  assert.deepEqual(ids(r), ["FR-001", "FR-002"]);
  assert.ok(!r.warnings.includes("pdf-stream-damaged"));
});

// ---------- PR30-r11 ----------
test("AT4l comments inside the integer object of an indirect /Length (and inside an object header) are allowed", () => {
  const content = "BT (FR-001 before) Tj T* (text: endstream endobj) Tj T* (FR-002 after) Tj ET";
  const data = deflateSync(Buffer.from(content, "latin1"), { level: 0 });
  const doc = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n" +
        "3 % page object\n0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
        "4 0 obj\n<< /Length 19 0 R /Filter /FlateDecode >>\nstream\n",
      "latin1",
    ),
    data,
    Buffer.from(`\nendstream\nendobj\n19 0 obj\n% stream length\n${data.length} % bytes\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1"),
  ]);
  const r = parseSpec(doc, "commented.pdf");
  assert.deepEqual(ids(r), ["FR-001", "FR-002"]);
  assert.ok(!r.warnings.includes("pdf-page-order-unknown"));
});

test("AT4m many comment lines between tokens cannot cause catastrophic backtracking", () => {
  const junk = "1 0 " + "% %% %  % x\n".repeat(20000) + "nope\n";
  const t0 = Date.now();
  assert.equal(code(() => parseSpec(Buffer.from("%PDF-1.4\n" + junk + "%%EOF\n", "latin1"), "slow.pdf")), "pdf-no-text");
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

// ---------- PR30-r12 ----------
test("AT5b inherited property names are never a format or an entity", async () => {
  for (const n of ["spec.constructor", "spec.toString", "spec.__proto__", "spec.hasOwnProperty", "spec.valueOf"]) {
    assert.equal(code(() => parseSpec(enc("# FR-1"), n)), "type-unknown", n);
    await assert.rejects(ingest(enc("# FR-1"), n), (e) => e instanceof IngestError && e.code === "type-unknown");
  }
  const r = parseSpec(enc("<p>&constructor; &toString; &amp; FR-1</p>"), "e.html");
  assert.equal(r.blocks[0].text, "&constructor; &toString; & FR-1");
});

// ---------- PR30-r13 ----------
test("AT4n indirect /Length comes from a real integer object, never from a decoy in a string or comment", () => {
  const content = "BT (FR-001 before) Tj T* (text: endstream endobj) Tj T* (FR-002 after) Tj ET";
  const data = deflateSync(Buffer.from(content, "latin1"), { level: 0 });
  // A decoy length that lands exactly on the "endstream" inside the stored bytes (it would pass the endstream check).
  const tricky = data.indexOf(Buffer.from("endstream"));
  const build = (decoys) =>
    Buffer.concat([
      Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n" +
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n" +
          "4 0 obj\n<< /Length 19 0 R /Filter /FlateDecode >>\nstream\n",
        "latin1",
      ),
      data,
      Buffer.from(`\nendstream\nendobj\n19 0 obj\n${data.length}\nendobj\n${decoys}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1"),
    ]);
  for (const decoys of [
    "5 0 obj\n<< /Note (19 0 obj 1 endobj) >>\nendobj\n",
    `5 0 obj\n<< /Note (19 0 obj ${tricky} endobj) >>\nendobj\n`,
    `% 19 0 obj ${tricky} endobj\n`,
  ]) {
    const r = parseSpec(build(decoys), "decoy.pdf");
    assert.deepEqual(ids(r), ["FR-001", "FR-002"], decoys);
    assert.ok(!r.warnings.includes("pdf-stream-damaged"), decoys);
  }
});
