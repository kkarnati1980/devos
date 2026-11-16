// SM-11-L1 (real browser): the main journey passes end to end in Chromium at 1440×900 and 390×844, with a
// screenshot per width and an e2e report in e2e-report/ (CI keeps that folder as the evidence).
// Run with `npm run test:e2e` after adding the playwright devDependency (see the add-on's usage).
// The demo page and steps below are placeholders: replace them with the app's real main journey from its
// requirements file, keeping one runJourney call with the real routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../../src/server.mjs";
import { runJourney } from "../../src/journey.mjs";

const OUT = process.env.E2E_REPORT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../e2e-report");

const DEMO = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo</title><style>body{font-family:system-ui;margin:0;padding:16px}main{max-width:960px;margin:auto}button{min-height:44px}</style></head>
<body><main><h1>Demo journey</h1><form method="get" action="/done"><label>Name <input name="who" required></label> <button type="submit">Continue</button></form></main></body></html>`;

const html = (body) => (_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'", "cache-control": "no-store" });
  res.end(body);
};

let server, browser, baseURL;
before(async () => {
  server = createApp({ routes: { "GET /": html(DEMO), "GET /done": html('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Done</title></head><body><p role="status">Saved</p></body></html>') }, out: { write() {} } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

test("SM-11-L1: the main journey passes at desktop and phone widths, with screenshots stored", async () => {
  const report = await runJourney({ browser, baseURL, outDir: OUT, steps: async (page) => {
    await page.goto("/");
    await page.getByLabel("Name").fill("Asha");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("status").waitFor();
    assert.equal(await page.getByRole("status").textContent(), "Saved");
  } });
  assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
  assert.deepEqual(report.results.map((r) => r.screenshot), ["main-journey-desktop.png", "main-journey-phone.png"]);
});
