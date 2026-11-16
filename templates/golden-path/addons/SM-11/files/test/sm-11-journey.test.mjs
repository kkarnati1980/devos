// SM-11-L1 (mechanism): runJourney runs the main journey at both widths, stores a screenshot per width and an
// e2e report, and fails a width on a step error, page error, console error, horizontal overflow or a hang.
// These tests use a fake browser, so they run with plain `node --test`. The real Chromium run is
// test/e2e/main-journey.e2e.mjs (`npm run test:e2e`, see the add-on's usage).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJourney, VIEWPORTS } from "../src/journey.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sm11-"));

// A minimal stand-in for a Playwright Browser. `behave(viewport)` returns per-context behaviour.
function fakeBrowser(behave = () => ({})) {
  const log = [];
  return {
    log,
    async newContext(opts) {
      const b = behave(opts.viewport) || {};
      log.push({ op: "newContext", viewport: opts.viewport, baseURL: opts.baseURL });
      const handlers = {};
      const page = {
        on(ev, fn) { handlers[ev] = fn; },
        emit(ev, arg) { handlers[ev]?.(arg); },
        async goto(url) { log.push({ op: "goto", url }); b.onGoto?.(page); },
        async evaluate() { if (b.evaluateHang) return new Promise(() => {}); return b.overflow ?? 0; },
        async screenshot({ path: p, fullPage }) {
          if (b.screenshotFails) throw new Error("target closed");
          log.push({ op: "screenshot", path: p, fullPage });
          fs.writeFileSync(p, "png");
        },
      };
      return { async newPage() { return page; }, async close() { log.push({ op: "close", viewport: opts.viewport }); } };
    },
  };
}

test("SM-11-L1: the journey runs at 1440×900 and 390×844, stores a screenshot per width and a report", async () => {
  const out = tmp();
  const browser = fakeBrowser();
  const seen = [];
  const report = await runJourney({ browser, baseURL: "http://127.0.0.1:3000", outDir: out, sha: "abc123", now: () => new Date("2026-11-16T15:00:00Z"),
    steps: async (page, ctx) => { seen.push(ctx.viewport); await page.goto("/"); } });
  assert.deepEqual(VIEWPORTS, { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } });
  assert.deepEqual(seen, ["desktop", "phone"]);
  assert.deepEqual(browser.log.filter((l) => l.op === "newContext").map((l) => l.viewport), [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
  assert.equal(browser.log.filter((l) => l.op === "close").length, 2, "every context is closed");
  assert.ok(browser.log.filter((l) => l.op === "screenshot").every((l) => l.fullPage));
  assert.equal(report.ok, true);
  assert.equal(report.check, "SM-11-L1");
  assert.equal(report.sha, "abc123");
  assert.equal(report.at, "2026-11-16T15:00:00.000Z");
  assert.deepEqual(report.results.map((r) => [r.viewport, r.ok, r.screenshot, r.problems]), [
    ["desktop", true, "main-journey-desktop.png", []],
    ["phone", true, "main-journey-phone.png", []],
  ]);
  assert.ok(fs.existsSync(path.join(out, "main-journey-desktop.png")));
  assert.ok(fs.existsSync(path.join(out, "main-journey-phone.png")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "main-journey-report.json"), "utf8")), report);
  assert.deepEqual(fs.readdirSync(out).filter((f) => f.endsWith(".tmp")), [], "no temp file left");
});

test("SM-11-L1: a failing width fails the report but the other width still runs and is recorded", async () => {
  const out = tmp();
  const browser = fakeBrowser();
  const report = await runJourney({ browser, baseURL: "http://127.0.0.1:3000", outDir: out,
    steps: async (_page, { viewport }) => { if (viewport === "phone") throw new Error("button not found"); } });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results[1].ok, false);
  assert.match(report.results[1].problems[0], /^step: button not found/);
  assert.equal(report.results[1].screenshot, "main-journey-phone.png", "a screenshot of the failed state is kept");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "main-journey-report.json"), "utf8")).ok, false);
});

test("SM-11-L1: page errors, console errors and horizontal overflow fail that width", async () => {
  const out = tmp();
  const browser = fakeBrowser((vp) => vp.width === 390
    ? { overflow: 120, onGoto: (p) => { p.emit("pageerror", new Error("x is undefined")); p.emit("console", { type: () => "error", text: () => "404 /app.js" }); p.emit("console", { type: () => "log", text: () => "fine" }); } }
    : {});
  const report = await runJourney({ browser, baseURL: "http://127.0.0.1:3000", outDir: out, steps: (page) => page.goto("/") });
  assert.equal(report.results[0].ok, true);
  assert.deepEqual(report.results[1].problems, [
    "pageerror: x is undefined",
    "console: 404 /app.js",
    "layout: page is 120px wider than the 390px viewport",
  ]);
  assert.equal(report.ok, false);
});

test("SM-11-L1: a hung step or layout check times out, a failed screenshot fails the width, contexts still close", async () => {
  const out = tmp();
  const browser = fakeBrowser((vp) => (vp.width === 1440 ? { evaluateHang: true } : { screenshotFails: true }));
  const t0 = Date.now();
  const report = await runJourney({ browser, baseURL: "http://127.0.0.1:3000", outDir: out, timeoutMs: 100,
    steps: (_p, { viewport }) => (viewport === "desktop" ? new Promise(() => {}) : undefined) });
  assert.ok(Date.now() - t0 < 2000, "bounded by the timeouts");
  assert.match(report.results[0].problems[0], /^step: journey timed out after 100 ms/);
  assert.match(report.results[0].problems[1], /^screenshot: layout check timed out/);
  assert.equal(report.results[0].screenshot, null);
  assert.match(report.results[1].problems[0], /^screenshot: target closed/);
  assert.equal(report.results[1].screenshot, null);
  assert.equal(report.ok, false);
  assert.equal(browser.log.filter((l) => l.op === "close").length, 2);
});

test("SM-11-L1: a browser that cannot open a context fails both widths and still writes the report", async () => {
  const out = tmp();
  const browser = { async newContext() { throw new Error("browser has been closed"); } };
  const report = await runJourney({ browser, baseURL: "http://127.0.0.1:3000", outDir: out, steps: () => {} });
  assert.deepEqual(report.results.map((r) => [r.ok, r.problems]), [
    [false, ["browser: browser has been closed"]],
    [false, ["browser: browser has been closed"]],
  ]);
  assert.ok(fs.existsSync(path.join(out, "main-journey-report.json")));
});

test("SM-11-L1: bad arguments are refused before anything runs", async () => {
  const out = tmp();
  const browser = fakeBrowser();
  const ok = { browser, baseURL: "http://127.0.0.1:3000", outDir: out, steps: () => {} };
  await assert.rejects(runJourney({ ...ok, browser: {} }), /browser/);
  await assert.rejects(runJourney({ ...ok, steps: "go" }), /steps/);
  await assert.rejects(runJourney({ ...ok, name: "../x" }), /name/);
  await assert.rejects(runJourney({ ...ok, outDir: "" }), /outDir/);
  await assert.rejects(runJourney({ ...ok, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(runJourney({ ...ok, baseURL: "file:///etc/passwd" }), /baseURL/);
  await assert.rejects(runJourney({ ...ok, baseURL: "not a url" }));
  assert.deepEqual(browser.log, []);
});
