// M1.3 browser acceptance tests (Chromium via Playwright; CI workflow dashboard-e2e).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startDashboard } from "../helpers.mjs";

let dash, browser;
before(async () => {
  dash = await startDashboard();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await dash?.close();
});

async function open(path, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("dialog", async (d) => { problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const t0 = Date.now();
  const res = await page.goto(dash.base + path, { waitUntil: "load" });
  const loadMs = Date.now() - t0;
  await page.waitForLoadState("networkidle");
  return { page, context, res, loadMs, problems };
}

test("AT1b Done-when in a browser: 20 projects load in under 2 s", async () => {
  await (await open("/")).context.close(); // warm
  const { page, context, loadMs, problems } = await open("/", { width: 1280, height: 800 });
  assert.equal(await page.locator('[data-testid="project-card"]').count(), 20);
  assert.ok(loadMs < 2000, `load took ${loadMs} ms`);
  assert.deepEqual(problems, []);
  await context.close();
});

test("AT3b (PS) seeded <script> in spec, agent summary and log never executes (CSP active, page hydrates)", async () => {
  const { page, context, problems } = await open("/projects/xss-probe", { width: 1280, height: 800 });
  await page.getByTestId("project-name").hover();
  const state = await page.evaluate(() => ({ xss: window.__devosXss, violations: window.__cspViolations, hydrated: typeof window.next === "object" }));
  assert.equal(state.xss, undefined, "a payload ran");
  assert.deepEqual(state.violations, [], "Next.js scripts must run under the nonce without violations");
  assert.equal(state.hydrated, true);
  assert.equal(await page.locator("iframe, svg, img").count(), 0);
  assert.match(await page.getByTestId("spec-text").innerText(), /<script>window\.__devosXss = "spec"<\/script>/);
  assert.match(await page.getByTestId("log").innerText(), /<svg onload=/);
  assert.match((await page.getByTestId("agent-summary").allInnerTexts()).join("\n"), /<script>window\.__devosXss = "summary"<\/script>/);
  assert.deepEqual(problems, []);
  await context.close();
});

test("AT9 (PS) home and project page render at 390×844 with no horizontal scroll", async () => {
  for (const path of ["/", "/projects/xss-probe", "/projects/social-content-extraction"]) {
    const { page, context, res, problems } = await open(path);
    assert.equal(res.status(), 200, path);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(m.sw <= m.cw, `${path}: scrollWidth ${m.sw} > ${m.cw}`);
    const first = await page.locator('[data-testid="project-card"], [data-testid="module-board"]').first().boundingBox();
    assert.ok(first && first.x >= 0 && first.x + first.width <= 390, `${path}: content off screen`);
    assert.deepEqual(problems, []);
    await context.close();
  }
});
