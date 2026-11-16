// SM-11 UI quality (Lite): run the app's main journey end to end at desktop (1440×900) and phone (390×844)
// widths, store a screenshot per width, and write an e2e report (evidence e2e_report, check SM-11-L1).
// The browser is injected (a Playwright `Browser`, e.g. `await chromium.launch()`), so this file imports no
// browser package and runs anywhere; only the app's e2e test needs Chromium (docs/modules/S3.md, S3-c5).
import fs from "node:fs/promises";
import path from "node:path";

export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  phone: Object.freeze({ width: 390, height: 844 }),
});

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Bound a promise. The timer is cleared as soon as the promise settles; it is not unref'd, because a hung
// step must still end in a timeout rather than the process exiting with the journey unfinished.
function within(ms, p, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Run `steps(page, { viewport, baseURL })` once per viewport in a fresh context. A viewport fails when a step
// throws or times out, the page raises an uncaught error or logs a console error, or the page is wider than the
// viewport (horizontal scrolling at that width). A failing viewport never stops the other one. The screenshot is
// taken after the steps (also after a failure, when the page still answers) and the report is always written.
export async function runJourney({ browser, baseURL, name = "main-journey", steps, outDir, timeoutMs = 30_000, sha = process.env.GIT_SHA || null, now = () => new Date() }) {
  if (!browser || typeof browser.newContext !== "function") throw new TypeError("runJourney: browser must be a Playwright Browser");
  if (typeof steps !== "function") throw new TypeError("runJourney: steps must be a function");
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("runJourney: name must be lowercase letters, digits and dashes");
  if (typeof outDir !== "string" || !outDir) throw new TypeError("runJourney: outDir is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("runJourney: timeoutMs must be a positive integer");
  const base = new URL(baseURL); // throws on a malformed URL
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("runJourney: baseURL must be http(s)");
  await fs.mkdir(outDir, { recursive: true });

  const results = [];
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    const problems = [];
    let context;
    let screenshot = null;
    const started = Date.now();
    try {
      const opening = Promise.resolve().then(() => browser.newContext({ viewport: { ...viewport }, baseURL: base.href }));
      // A context that opens after its timeout is closed when it arrives, so a slow browser leaks none.
      context = await within(timeoutMs, opening, "new context").catch((e) => {
        opening.then((late) => late?.close?.()).catch(() => {});
        throw e;
      });
      const page = await within(timeoutMs, context.newPage(), "new page");
      page.on("pageerror", (e) => problems.push(`pageerror: ${String(e && e.message).slice(0, 300)}`));
      page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${String(m.text()).slice(0, 300)}`); });
      try {
        await within(timeoutMs, Promise.resolve().then(() => steps(page, { viewport: viewportName, baseURL: base.href })), "journey");
      } catch (e) {
        problems.push(`step: ${String(e && e.message).slice(0, 300)}`);
      }
      try {
        const overflow = await within(timeoutMs, page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "layout check");
        if (overflow > 0) problems.push(`layout: page is ${overflow}px wider than the ${viewport.width}px viewport`);
      } catch (e) {
        problems.push(`layout: ${String(e && e.message).slice(0, 300)}`);
      }
      try {
        const file = path.join(outDir, `${name}-${viewportName}.png`);
        await within(timeoutMs, page.screenshot({ path: file, fullPage: true }), "screenshot");
        screenshot = path.basename(file);
      } catch (e) {
        problems.push(`screenshot: ${String(e && e.message).slice(0, 300)}`);
      }
    } catch (e) {
      problems.push(`browser: ${String(e && e.message).slice(0, 300)}`);
    } finally {
      if (context) await within(timeoutMs, context.close(), "close context").catch(() => {});
    }
    results.push({ viewport: viewportName, width: viewport.width, height: viewport.height, ok: problems.length === 0 && screenshot !== null, ms: Date.now() - started, screenshot, problems });
  }

  const report = { check: "SM-11-L1", journey: name, sha, at: now().toISOString(), ok: results.every((r) => r.ok), results };
  const tmp = path.join(outDir, `.${name}-report.json.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(report, null, 2) + "\n");
  await fs.rename(tmp, path.join(outDir, `${name}-report.json`));
  return report;
}
