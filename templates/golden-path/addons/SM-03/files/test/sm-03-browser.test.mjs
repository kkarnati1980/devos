// SM-03 add-on tests (docs/modules/S3.md, "S3-b3 SM-03 build notes").
// SM-03-L1: a cross-origin state-changing request is refused, and the handler is never reached.
// SM-03-L2: output is escaped, and the app's code has no raw-HTML sinks.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  createOriginGuard, assertAllProtected, originsFromEnv, html, escapeHtml, sendHtml, isSafeHtml, isSafeUrl, findRawHtmlSinks, SINKS,
} from "../src/browser-safety.mjs";

const APP = "https://app.example";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withRoutes(routes, fn) {
  const app = createApp({ config: loadConfig({ GIT_SHA: "abc1234" }), out: { write: () => {} }, routes });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try { await fn(app.address().port); } finally { app.close(); }
}

// node:http, so Origin and Sec-Fetch-* can be set exactly as a browser would send them.
function send(port, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function sampleRoutes(reached) {
  const ok = (name) => (req, res) => { reached.push(name); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
  return { "GET /notes": ok("list"), "POST /notes": ok("create"), "PUT /notes": ok("replace"), "PATCH /notes": ok("edit"), "DELETE /notes": ok("delete") };
}

test("SM-03-L1: a cross-origin state-changing request is refused with 403 and never reaches the handler", async () => {
  const reached = [];
  const guard = createOriginGuard({ allowedOrigins: [APP] });
  await withRoutes(guard.protectAll(sampleRoutes(reached)), async (port) => {
    const refusedCases = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "https://app.example.evil.example" },
      { origin: "http://app.example" }, // scheme differs
      { origin: "https://app.example:8443" }, // port differs
      { origin: APP, "sec-fetch-site": "cross-site" },
      { origin: APP, "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
      {}, // no Origin, no Sec-Fetch-Site, no Authorization
      { origin: "https://evil.example", authorization: "Bearer x" }, // an Origin header decides even with a token
    ];
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const h of refusedCases) {
        const r = await send(port, method, "/notes", h);
        assert.equal(r.status, 403, `${method} ${JSON.stringify(h)}`);
        assert.deepEqual(JSON.parse(r.body), { error: "cross-origin-refused" });
        assert.ok(!r.body.includes("evil"), "no reflection");
      }
    }
    assert.deepEqual(reached, [], "no refused request reached a handler");
    // Same-origin browser requests and header-less service callers with a token pass.
    for (const h of [{ origin: APP }, { origin: APP, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin" }, { authorization: "Bearer t0ken" }]) {
      assert.equal((await send(port, "POST", "/notes", h)).status, 200, JSON.stringify(h));
    }
    // Reads are not state-changing and pass from anywhere; /health stays open.
    assert.equal((await send(port, "GET", "/notes", { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 200);
    assert.equal((await send(port, "GET", "/health")).status, 200);
    // No CORS preflight is answered, so another origin cannot add an Authorization header.
    assert.equal((await send(port, "OPTIONS", "/notes", { origin: "https://evil.example", "access-control-request-method": "POST" })).status, 404);
  });
  assert.equal(reached.length, 5);
});

test("SM-03-L1: set-up refusals and the route check", () => {
  for (const bad of [undefined, [], [""], ["app.example"], ["https://app.example/"], ["https://app.example/path"], ["ftp://app.example"], ["https://user@app.example"], [42]]) {
    assert.throws(() => createOriginGuard({ allowedOrigins: bad }), TypeError, JSON.stringify(bad));
  }
  assert.deepEqual(createOriginGuard({ allowedOrigins: ["https://app.example", "http://localhost:3000"] }).origins, ["https://app.example", "http://localhost:3000"]);
  assert.deepEqual(originsFromEnv({ APP_ORIGINS: " https://a.example , https://b.example ,," }), ["https://a.example", "https://b.example"]);
  const guard = createOriginGuard({ allowedOrigins: [APP] });
  const routes = sampleRoutes([]);
  assert.throws(() => assertAllProtected(routes), /POST \/notes, PUT \/notes, PATCH \/notes, DELETE \/notes/);
  const forged = { "POST /x": Object.assign(() => {}, { protected: true }) };
  assert.throws(() => assertAllProtected(forged), /POST \/x/);
  assert.doesNotThrow(() => assertAllProtected(guard.protectAll(routes)));
  assert.doesNotThrow(() => assertAllProtected({ "GET /only-reads": () => {} }));
});

test("SM-03-L2: html`` escapes every value and refuses unsafe places", () => {
  const evil = `<img src=x onerror="alert(1)">'&\`=`;
  assert.equal(String(html`<p>${evil}</p>`), "<p>&lt;img src&#61;x onerror&#61;&quot;alert(1)&quot;&gt;&#39;&amp;&#96;&#61;</p>");
  assert.equal(String(html`<a title="${evil}">x</a>`), `<a title="${escapeHtml(evil)}">x</a>`);
  assert.equal(String(html`<textarea>${"</textarea><script>"}</textarea>`), "<textarea>&lt;/textarea&gt;&lt;script&gt;</textarea>");
  // Nested results and lists are kept, other values escaped once.
  const items = ["<b>", "a&b"].map((x) => html`<li>${x}</li>`);
  assert.equal(String(html`<ul>${items}</ul>`), "<ul><li>&lt;b&gt;</li><li>a&amp;b</li></ul>");
  assert.equal(String(html`<p>${null}${undefined}${0}</p>`), "<p>0</p>");
  assert.equal(String(html`<p>x = ${1}</p>`), "<p>x = 1</p>"); // "=" in text is fine
  // URL attributes: only http(s), mailto and relative URLs.
  for (const u of ["https://a.example/x", "/notes?id=1", "notes/1", "#top", "?q=1", "mailto:kk@example.com", "../up"]) {
    assert.ok(String(html`<a href="${u}">x</a>`).startsWith('<a href="'), u);
  }
  for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " java\tscript:alert(1)", "\u0001javascript:x", "data:text/html,<script>", "vbscript:x"]) {
    assert.throws(() => html`<a href="${u}">x</a>`, /URL attribute/, JSON.stringify(u));
    assert.throws(() => html`<form action='${u}'></form>`, /URL attribute/, JSON.stringify(u));
    assert.equal(isSafeUrl(u), false, JSON.stringify(u));
  }
  assert.equal(String(html`<a href="/search?q=${"javascript:x"}">x</a>`), '<a href="/search?q=javascript:x">x</a>'); // not at the start
  // The whole attribute is judged when it closes, as the browser reads it (pre-review r1).
  const u = "javascript:alert(1)";
  for (const render of [
    () => html`<a href=" ${u}">x</a>`,
    () => html`<a href="
        ${u}">x</a>`,
    () => html`<a href="&#32;${u}">x</a>`,
    () => html`<a href="${"javascript"}${":alert(1)"}">x</a>`,
    () => html`<a href="${html`${u}`}">x</a>`,
    () => html`<a href="java${"script:alert(1)"}">x</a>`,
    () => html`<a href="${"java"}&#115;cript:alert(1)">x</a>`,
  ]) assert.throws(render, /URL attribute/, String(render));
  assert.equal(String(html`<a href="javascript:void(0)" title="${"t"}">x</a>`), '<a href="javascript:void(0)" title="t">x</a>'); // static, no value: the author's
  assert.equal(String(html`<img srcset="${"a.png"} 1x, ${"https://cdn.example/b.png"} 2x">`), '<img srcset="a.png 1x, https://cdn.example/b.png 2x">');
  // srcdoc, code-loading tags and SVG animation values are refused whatever the value.
  assert.throws(() => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`, /srcdoc/);
  assert.throws(() => html`<script src="${"https://evil.example/x.js"}"></script>`, /code-loading/);
  assert.throws(() => html`<base href="${"https://evil.example/"}">`, /code-loading/);
  assert.throws(() => html`<svg><animate attributeName="href" values="${u}"/></svg>`, /code-loading/);
  assert.throws(() => html`<svg><set to="${u}"/></svg>`, /code-loading/);
  assert.throws(() => html`<meta http-equiv="refresh" content="${"0;url=https://evil.example"}">`, /code-loading/);
  assert.equal(String(html`<link rel="stylesheet" href="/a.css"><p title="${"ok"}">${"x"}</p>`), '<link rel="stylesheet" href="/a.css"><p title="ok">x</p>');
  // Refused contexts.
  assert.throws(() => html`<script>const n = ${"x"};</script>`, /inside <script>/);
  assert.throws(() => html`<STYLE>p { color: ${"red"} }</STYLE>`, /inside <style>/);
  assert.throws(() => html`<!-- ${"x"} -->`, /inside/);
  assert.throws(() => html`<a href=${"/x"}>x</a>`, /quote every attribute/);
  assert.throws(() => html`<div ${"onclick=alert(1)"}>x</div>`, /quote every attribute/);
  assert.throws(() => html`<button onclick="go(${"1"})">x</button>`, /event-handler/);
  assert.throws(() => html`<p style="color: ${"red"}">x</p>`, /style/);
  assert.throws(() => html("<p>x</p>"), /tagged template/);
  // Pre-review r2: a value may not name a tag, an end tag needs its terminator, <!-- in a script is refused, and
  // <textarea>/<title> content is text, so markup-looking text there does not open a tag.
  assert.throws(() => html`<${"script"}>${"alert(1)"}</script>`, /name a tag/);
  assert.throws(() => html`</${"p"}>`, /quote every attribute/);
  assert.throws(() => html`<script>var s = "</scripts>"; ${"x"}</script>`, /inside <script>/);
  assert.equal(String(html`<script>var s = "</scripts>";</script>${"<"}`), '<script>var s = "</scripts>";</script>&lt;');
  assert.throws(() => html`<script><!--<script></script>\n${"alert(1)"}\n</script>`, /<!-- inside <script>/);
  assert.equal(String(html`<textarea><p title="</textarea><img src="/i.png" alt="${"x"}">">`), '<textarea><p title="</textarea><img src="/i.png" alt="x">">');
  assert.throws(() => html`<textarea><p title="</textarea><img src=x onerror=${"alert(1)"}>">`, /quote every attribute/);
  assert.equal(String(html`<title>${"<b>"}</title><p>${"&"}</p>`), "<title>&lt;b&gt;</title><p>&amp;</p>");
  assert.equal(String(html`<p>a < b, ${"c"}</p>`), "<p>a < b, c</p>"); // a "<" followed by a space is text
  // After a closed raw-text element, values are allowed again.
  assert.equal(String(html`<script src="/a.js"></script><p>${"<"}</p>`), '<script src="/a.js"></script><p>&lt;</p>');
  // The result is branded; a look-alike object is not accepted.
  assert.ok(isSafeHtml(html`<p></p>`));
  assert.ok(!isSafeHtml({ toString: () => "<p></p>" }));
});

test("SM-03-L2: sendHtml sends only html`` results, with nosniff", async () => {
  await withRoutes({
    "GET /page": (req, res) => sendHtml(res, html`<h1>${"<b>KK</b>"}</h1>`),
    "GET /raw": (req, res) => sendHtml(res, "<h1>raw</h1>"),
  }, async (port) => {
    const r = await send(port, "GET", "/page");
    assert.equal(r.status, 200);
    assert.equal(r.body, "<h1>&lt;b&gt;KK&lt;/b&gt;</h1>");
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    const raw = await send(port, "GET", "/raw");
    assert.equal(raw.status, 500);
    assert.ok(!raw.body.includes("raw</h1>"));
  });
});

test("SM-03-L2: the raw-HTML sink check finds every sink kind and passes this app", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm03-"));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const P = (...p) => p.join(""); // fixtures are assembled so this test file holds no sink itself
  const cases = {
    "react-dangerously-set": ["src/a.jsx", P("<div dangerously", "SetInnerHTML={{ __html: x }} />")],
    "inner-html": ["public/b.js", P("el.inner", "HTML = userText;")],
    "inner-html-bracket": ["public/b2.js", P("el['inner", "HTML'] = t;")],
    "outer-html": ["public/c.mjs", P("el.outer", "HTML += t;")],
    "insert-adjacent-html": ["public/d.ts", P("el.insertAdjacent", "HTML('beforeend', t)")],
    "document-write": ["public/e.html", P("<script>document.", "writeln(t)</script>")],
    "create-contextual-fragment": ["src/f.mjs", P("range.createContextual", "Fragment(t)")],
    "set-html-unsafe": ["public/g.js", P("el.setHTML", "Unsafe(t)")],
    "vue-vhtml-directive": ["src/h.vue", P("<div v-", "html=\"msg\"></div>")],
    "svelte-at-html": ["src/i.svelte", P("{@", "html post.body}")],
    "template-safe-filter": ["src/j.njk", P("{{ body |", " safe }}")],
    "handlebars-triple": ["src/k.hbs", P("{{", "{body}}}")],
    "angular-inner-html": ["src/l.html", P("<div [inner", "HTML]=\"x\"></div>")],
    "iframe-src-doc": ["public/m.html", P("<iframe src", "doc=\"x\"></iframe>")],
    "jquery-html": ["public/n.js", P("$(el).", "html(userText)")],
    "mustache-ampersand": ["src/o.mustache", P("{{", "& body}}")],
    "ejs-unescaped": ["src/p.ejs", P("<p><%", "- body %></p>")],
    "inner-html-key": ["src/s1.mjs", P("const props = { inner", "HTML: t };")],
    "template-raw-filter": ["src/s2.twig", P("<p>{{ body|", "raw }}</p>")],
    "template-autoescape-off": ["src/s3.jinja", P("{% auto", "escape off %}")],
    "lit-unsafe-html": ["src/q.mjs", P("html`${unsafe", "HTML(t)}`")],
  };
  // More forms of the same sinks (pre-review r1): each must be found too, at the line where it starts.
  const forms = [
    ["inner-html", "src/r1.mjs", P("el.inner", "HTML ||= t;")],
    ["inner-html", "src/r2.mjs", P("el.inner", "HTML ??= t;")],
    ["inner-html", "src/r3.mjs", P("el.inner", "HTML\n    = t;")],
    ["inner-html-key", "src/r4.mjs", P("Object.assign(el, { inner", "HTML: t });")],
    ["inner-html", "src/r5.vue", P("<div :inner", "HTML=\"t\"></div>")],
    ["inner-html", "src/r6.jsx", P("<div inner", "HTML={t} />")],
    ["iframe-src-doc", "src/r7.mjs", P("el.setAttribute('src", "doc', t);")],
    ["jquery-html", "public/r8.js", P("jQuery('#x').", "append(userHtml);")],
    ["jquery-html", "public/r9.js", P("$('#x')\n  .", "replaceWith(userHtml);")],
    ["jquery-html", "public/r10.js", P("$('#x').find('.y').", "html(userText);")],
    ["jquery-html", "public/r11.js", P("$(this.el()).", "html(t);")],
    ["document-write", "public/r12.js", P("frame.contentDocument.", "write(x);")],
    ["template-raw-filter", "src/r13.twig", P("{{ body |", "raw }}")],
    ["template-autoescape-off", "src/r14.njk", P("{% auto", "escape false %}{{ body }}")],
  ];
  assert.deepEqual(Object.keys(cases).sort(), SINKS.map(([n]) => n).sort(), "every sink kind has a fixture");
  for (const [, [rel, text]] of Object.entries(cases)) write(rel, `const a = 1;\n${text}\n`);
  for (const [, rel, text] of forms) write(rel, `const a = 1;\n${text.replaceAll("\\n", "\n").replaceAll('\\"', '"')}\n`);
  write("public/clean.js", "el.textContent = userText;\nconst same = el.innerText === x;\nif (a.innerHTML === b) {}\n$(el).html();\n");
  // Not sinks: "|| safe" in script, a server framework's c.html(page) helper, html`` itself, and ejs-like text in JS.
  write("src/clean3.mjs", "const t = cond ? el.innerHTML : '';\n");
  write("public/build/bundle.js", P("el.inner", "HTML = x")); // build output of src/, which is scanned itself
  write("public/vendor/lib.js", P("el.inner", "HTML = x"));
  write("public/lib.min.js", P("el.inner", "HTML = x"));
  write("src/clean2.mjs", "if (ok || safe) {}\nreturn c.html(page);\nreply.html(html`<p>${x}</p>`);\nconst s = '<%-';\n");
  write("src/notes.md", P("el.inner", "HTML = x")); // not a scanned file type
  write("node_modules/x/index.js", P("el.inner", "HTML = x")); // dependencies are not the app's code
  const hits = findRawHtmlSinks(dir);
  for (const [sink, [rel]] of Object.entries(cases)) assert.ok(hits.some((h) => h.sink === sink && h.file === rel && h.line === 2), `${sink} in ${rel}\n${JSON.stringify(hits)}`);
  for (const [sink, rel] of forms) assert.ok(hits.some((h) => h.sink === sink && h.file === rel && h.line === 2), `${sink} form in ${rel}\n${JSON.stringify(hits)}`);
  assert.ok(!hits.some((h) => ["public/clean.js", "src/clean2.mjs", "src/clean3.mjs", "src/notes.md", "public/build/bundle.js", "public/vendor/lib.js", "public/lib.min.js"].includes(h.file) || h.file.startsWith("node_modules")), JSON.stringify(hits));
  fs.rmSync(dir, { recursive: true, force: true });
  // This app (the generated project, including this add-on) has no raw-HTML sink in src/ or public/.
  assert.deepEqual(findRawHtmlSinks(APP_ROOT), []);
});
