// M1.4 browser acceptance tests: the wizard saves three caps and every secret against a stub API;
// a saved value is never in the DOM, page source, storage or URL; CSP holds; phone layout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { chromium } from "playwright";
import { startDashboard } from "../helpers.mjs";
import { startStubApi } from "./stub-api.mjs";

let dash, api, browser;

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

before(async () => {
  const dashPort = await freePort();
  api = await startStubApi(`http://127.0.0.1:${dashPort}`);
  process.env.DEVOS_API_ORIGIN = api.origin; // read per request by middleware.ts and the pages
  dash = await startDashboard({ PORT: String(dashPort) });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await dash?.close();
  await api?.close();
});

async function open(path) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.goto(dash.base + path, { waitUntil: "load" });
  return { page, context, res, problems };
}

const SECRETS = {
  anthropic_api_key: "TESTONLY-anthropic-aaaaaaaaaaaa-1A2B",
  openai_api_key: "TESTONLY-openai-bbbbbbbbbbbbbbb-3C4D",
  github_token: "TESTONLY-github-cccccccccccccccc-5E6F",
  linear_api_key: "TESTONLY-linear-ddddddddddddddd-7G8H",
  r2_access_key_id: "TESTONLY-r2id-eeeeeeeeeeeeeeeeeee-9I0J",
  r2_secret_access_key: "TESTONLY-r2secret-ffffffffffffff-KLMN",
  coolify_api_token: "TESTONLY-coolify-gggggggggggggg-OPQR",
};

test("M1.4 AT12 (amendment): the wizard saves three caps and every secret; no value is left in the page, storage or URL", async () => {
  const { page, context, res, problems } = await open("/setup");
  assert.equal(res.status(), 200);
  assert.match(res.headers()["content-security-policy"], new RegExp(`connect-src 'self' ${api.origin.replace(/[.]/g, "\\.")}(;|$)`));
  await page.getByTestId("caps-step").waitFor();

  await page.locator('input[name="openaiCapUsd"]').fill("20");
  await page.getByTestId("save-caps").click();
  await page.getByTestId("notice").filter({ hasText: "Caps saved." }).waitFor();
  const caps = JSON.parse(api.state.received.find((r) => r.url === "/setup/caps").body);
  assert.deepEqual(caps, { anthropicCapUsd: "15.00", openaiCapUsd: "20", defaultProjectCapUsd: "15.00" });

  for (const [name, value] of Object.entries(SECRETS)) {
    const row = page.getByTestId(`secret-${name}`);
    await row.locator('input[name="value"]').fill(value);
    await row.getByRole("button").click();
    await row.getByTestId("secret-state").filter({ hasText: `•••• ${value.slice(-4)}` }).waitFor();
    assert.equal(await row.locator('input[name="value"]').inputValue(), "", "field cleared after save");
  }
  // Rotate one.
  const gh = page.getByTestId("secret-github_token");
  await gh.locator('input[name="value"]').fill("TESTONLY-github-rotated-zzzzzzzzzz-WXYZ");
  await gh.getByRole("button", { name: "Replace" }).click();
  await page.getByTestId("notice").filter({ hasText: "replaced" }).waitFor();
  await gh.getByTestId("secret-state").filter({ hasText: "•••• WXYZ" }).waitFor();
  assert.equal(api.state.secrets.get("github_token"), "TESTONLY-github-rotated-zzzzzzzzzz-WXYZ");
  for (const [name, value] of Object.entries(SECRETS)) if (name !== "github_token") assert.equal(api.state.secrets.get(name), value);
  assert.ok(api.state.csrfSeen.length > 0 && api.state.csrfSeen.every((t) => t === "stub-csrf"), "every write carried the CSRF token");

  const dump = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    inputs: [...document.querySelectorAll("input")].map((i) => i.value),
    storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    url: location.href,
    violations: window.__cspViolations,
  }));
  const all = [dump.html, dump.inputs.join("\n"), dump.storage, dump.url].join("\n");
  for (const v of [...Object.values(SECRETS), "TESTONLY-github-rotated-zzzzzzzzzz-WXYZ"]) {
    assert.ok(!all.includes(v), `value left in the page: ${v.slice(-4)}`);
    assert.ok(!all.includes(v.slice(0, 20)), "value prefix left in the page");
  }
  assert.deepEqual(dump.violations, []);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
  assert.deepEqual(problems, []);
  await context.close();
});

test("M1.4 AT13: settings edits the caps, default lanes and deadlock attempts", async () => {
  const { page, context, problems } = await open("/settings");
  await page.getByTestId("settings-form").waitFor();
  assert.equal(await page.locator('select[name="deadlockAttempts"]').inputValue(), "3");
  await page.locator('input[name="anthropicCapUsd"]').fill("30");
  await page.locator('select[name="defaultLanes"]').selectOption("3");
  await page.getByTestId("save-settings").click();
  await page.getByTestId("notice").filter({ hasText: "Settings saved." }).waitFor();
  const sent = JSON.parse(api.state.received.filter((r) => r.url === "/settings").at(-1).body);
  assert.equal(sent.anthropicCapUsd, "30");
  assert.equal(sent.defaultLanes, 3);
  assert.equal(sent.deadlockAttempts, 3);
  assert.equal(await page.locator('input[name="anthropicCapUsd"]').inputValue(), "30.00");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw);
  assert.deepEqual(problems, []);
  await context.close();
});
