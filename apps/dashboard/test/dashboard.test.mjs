// M1.3 acceptance tests (HTTP level, against the production build).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard, NON_CSP_HEADERS, scriptTags } from "./helpers.mjs";
import { findSinks } from "../scripts/no-raw-html.mjs";
import { buildCsp } from "../lib/headers.mjs";

const payloads = JSON.parse(readFileSync(new URL("../lib/fixtures/xss-payloads.json", import.meta.url), "utf8"));
let dash;
before(async () => { dash = await startDashboard(); });
after(async () => { await dash?.close(); });

const get = (path) => fetch(dash.base + path, { redirect: "manual" });
const cards = (html, id) => (html.match(new RegExp(`data-testid="${id}"`, "g")) ?? []).length;

test("AT1 Done-when: 20 mock projects render on the home page in under 2 s", async () => {
  await get("/"); // first request warms the route
  const t0 = performance.now();
  const res = await get("/");
  const html = await res.text();
  const ms = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(cards(html, "project-card"), 20);
  assert.match(html, /20 projects/);
  assert.ok(ms < 2000, `home took ${ms.toFixed(0)} ms`);
});

test("AT2 project page shows the module board for every project; unknown or malformed slugs are 404", async () => {
  const home = await (await get("/")).text();
  const slugs = [...home.matchAll(/href="\/projects\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(slugs).size, 20);
  for (const slug of slugs) {
    const res = await get(`/projects/${slug}`);
    const html = await res.text();
    assert.equal(res.status, 200, slug);
    assert.match(html, /data-testid="module-board"/);
    assert.ok(cards(html, "module-card") >= 6, slug);
    for (const col of ["planned", "ready", "in progress", "in review", "merged", "deadlocked"]) assert.ok(html.includes(`aria-label="${col}"`), `${slug} ${col}`);
  }
  assert.equal((await get("/projects/no-such-project")).status, 404);
  assert.equal((await get("/projects/Bad_Slug!")).status, 404);
  assert.equal((await get("/projects/%3Cscript%3E")).status, 404);
});

test("AT3 (PS) seeded <script> in a spec, an agent summary and a log is escaped, never markup", async () => {
  const html = await (await get("/projects/xss-probe")).text();
  for (const key of ["spec", "summary", "log", "name"]) {
    const raw = payloads[key];
    assert.ok(!html.includes(raw), `${key} payload appears raw`);
    const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    assert.ok(html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").includes(escaped), `${key} payload not shown as text`);
  }
  for (const tag of scriptTags(html)) assert.match(tag, /\snonce="[A-Za-z0-9+/=]+"/, `script without nonce: ${tag}`);
  // Outside scripts: no element the payloads tried to inject, no event-handler attribute, no javascript: link.
  const bodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  for (const tag of markup.match(/<[a-z][^>]*>/gi) ?? []) {
    assert.doesNotMatch(tag, /^<(iframe|svg|img|b)\b/i, tag);
    assert.doesNotMatch(tag, /\son[a-z]+=/i, tag);
    assert.doesNotMatch(tag, /href="javascript:/i, tag);
  }
  // Inside Next.js's inline data scripts the payloads stay JSON-escaped: no raw "<" that could close the script.
  for (const body of bodies) assert.doesNotMatch(body, /<\/?(script|svg|iframe|img|b)\b/i);
  // the home page shows the hostile project name as text too
  const home = await (await get("/")).text();
  assert.ok(!home.includes(payloads.name));
  assert.doesNotMatch(home.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""), /<b\b/i);
});

test("AT4 (PS) strict CSP: per-request nonce on every script, no unsafe-*, no inline styles", async () => {
  const a = await get("/");
  const b = await get("/projects/xss-probe");
  const ca = a.headers.get("content-security-policy");
  const cb = b.headers.get("content-security-policy");
  for (const csp of [ca, cb]) {
    assert.ok(csp);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|unsafe-hashes|\*|https?:/);
    for (const d of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"]) assert.ok(csp.includes(d), d);
  }
  const na = ca.match(/'nonce-([^']+)'/)[1];
  const nb = cb.match(/'nonce-([^']+)'/)[1];
  assert.notEqual(na, nb, "nonce must change per request");
  assert.ok(na.length >= 24);
  const html = await a.text();
  const tags = scriptTags(html);
  assert.ok(tags.length > 0);
  for (const tag of tags) assert.ok(tag.includes(`nonce="${na}"`), `script not bound to this request's nonce: ${tag}`);
  for (const tag of html.match(/<style\b[^>]*>/gi) ?? []) assert.ok(tag.includes(`nonce="${na}"`), tag);
  assert.doesNotMatch(html, /\sstyle="/i);
  assert.throws(() => buildCsp("x'; script-src *"), /csp-nonce-invalid/);
});

test("AT5 (PS) security headers on pages, 404s and static assets; no X-Powered-By; pages not cached", async () => {
  const home = await get("/");
  const html = await home.text();
  const asset = html.match(/src="(\/_next\/static\/[^"]+\.js)"/)[1];
  for (const [path, status] of [["/", 200], ["/projects/no-such-project", 404], [asset, 200]]) {
    const res = await get(path);
    await res.arrayBuffer();
    assert.equal(res.status, status, path);
    for (const [k, v] of Object.entries(NON_CSP_HEADERS)) assert.equal(res.headers.get(k), v, `${path} ${k}`);
    assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
    assert.equal(res.headers.get("x-powered-by"), null, path);
    assert.equal(res.headers.get("strict-transport-security"), null, "no HSTS over plain HTTP");
  }
  assert.equal(home.headers.get("cache-control"), "no-store");
});

test("AT7 lint: raw-HTML sinks and inline styles are found; dashboard source has none", () => {
  assert.deepEqual(findSinks(), []);
  const dir = mkdtempSync(join(tmpdir(), "m13-lint-"));
  try {
    const f = join(dir, "bad.tsx");
    writeFileSync(f, [
      "export const A = () => <div dangerouslySetInnerHTML={{ __html: x }} />;",
      "el.innerHTML = s;",
      "export const B = () => <p style={{ color: 'red' }}>x</p>;",
      "eval(code);",
    ].join("\n"));
    const hits = findSinks([f]);
    for (const w of ["dangerouslySetInnerHTML", "innerHTML/outerHTML", "inline style prop", "eval"]) assert.ok(hits.some((h) => h.endsWith(w)), w);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AT8 contract: view-model enums equal the M1.1 schema enums; readiness panel placeholder present", async () => {
  const schema = readFileSync(new URL("../../../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
  const enumValues = (name) => schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))[1].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@@") && !l.startsWith("//"));
  const types = readFileSync(new URL("../lib/types.ts", import.meta.url), "utf8");
  const tsValues = (name) => JSON.parse(types.match(new RegExp(`${name} = (\\[[^\\]]*\\]) as const`))[1]);
  assert.deepEqual(tsValues("PROJECT_STAGES"), enumValues("ProjectStage"));
  assert.deepEqual(tsValues("MODULE_STATUSES"), enumValues("ModuleStatus"));
  assert.deepEqual(tsValues("RUN_ROLES"), enumValues("Role"));
  for (const path of ["/", "/projects/xss-probe"]) assert.match(await (await get(path)).text(), /data-testid="readiness-panel"/);
});
