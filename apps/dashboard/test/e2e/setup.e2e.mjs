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
  // A fresh context has no cookie, so the page's first session probe (GET /auth/session) is an
  // expected 401 before it signs in; at most one such resource error is allowed.
  let probe401 = 0;
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/^Failed to load resource: the server responded with a status of 401/.test(m.text()) && probe401++ === 0) return;
    problems.push(`console: ${m.text()}`);
  });
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
  mybrain_bell_key: "TESTONLY-bellkey-hhhhhhhhhhhhhh-STUV",
  smtp_password: "TESTONLY-smtppass-iiiiiiiiiiiii-WX12",
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
  assert.ok(api.state.csrfSeen.length > 0 && api.state.csrfSeen.every((t) => /^stub-csrf-\d+$/.test(t)), "every write carried the CSRF token");

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

test("M1.4 AT17 (PR17-r1): a second tab reuses the session; a tab whose token went stale recovers once and saves", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await context.newPage();
  await a.goto(dash.base + "/setup");
  await a.getByTestId("caps-step").waitFor();
  const signInsAfterA = api.state.signIns;
  const b = await context.newPage();
  await b.goto(dash.base + "/settings");
  await b.getByTestId("settings-form").waitFor();
  assert.equal(api.state.signIns, signInsAfterA, "opening a second tab must not rotate the shared session");

  // Something else signs in (a new cookie): tab A's in-memory token is now stale.
  const status = await b.evaluate(async (origin) => (await fetch(origin + "/auth/session", { method: "POST", credentials: "include" })).status, api.origin);
  assert.equal(status, 201);
  const refusedBefore = api.state.csrfRefused ?? 0;
  const row = a.getByTestId("secret-linear_api_key");
  await row.locator('input[name="value"]').fill("TESTONLY-linear-multitab-hhhhhhhhh-STUV");
  await row.getByRole("button").click();
  await row.getByTestId("secret-state").filter({ hasText: "•••• STUV" }).waitFor();
  assert.equal(api.state.csrfRefused, refusedBefore + 1, "first attempt refused, then retried once with the refreshed token");
  assert.equal(api.state.secrets.get("linear_api_key"), "TESTONLY-linear-multitab-hhhhhhhhh-STUV");

  await b.locator('input[name="openaiCapUsd"]').fill("21");
  await b.getByTestId("save-settings").click();
  await b.getByTestId("notice").filter({ hasText: "Settings saved." }).waitFor();
  await context.close();
});

test("M1.6 AT12: the notifications page sets the bell URL and recipient, sends a test card and shows each channel's outcome", async () => {
  const { page, context, problems } = await open("/notifications");
  await page.getByTestId("channels").waitFor();
  await page.locator('input[name="target-mybrain"]').fill("https://my-brain.example.com/api/devos/bell");
  await page.getByTestId("save-mybrain").click();
  await page.getByTestId("notice").filter({ hasText: "MyBrain bell saved." }).waitFor();
  await page.locator('input[name="target-email"]').fill("kk@example.com");
  await page.getByTestId("save-email").click();
  await page.getByTestId("notice").filter({ hasText: "Email saved." }).waitFor();
  await page.getByTestId("send-test").click();
  await page.getByTestId("notice").filter({ hasText: "Test card sent." }).waitFor();
  const result = await page.getByTestId("test-result").innerText();
  for (const label of ["Dashboard: sent", "MyBrain bell: sent", "Email: sent"]) assert.ok(result.includes(label), label);
  await page.getByTestId("feed-item").first().waitFor();
  assert.match(await page.getByTestId("feed-item").first().innerText(), /DevOS test card <script>/, "notice text is shown escaped, as text");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "a notice title never runs as script");
  const writes = api.state.received.filter((r) => r.url.startsWith("/notifications"));
  assert.deepEqual(writes.map((w) => w.url), ["/notifications/channels/mybrain", "/notifications/channels/email", "/notifications/test"]);
  assert.deepEqual(JSON.parse(writes[0].body), { target: "https://my-brain.example.com/api/devos/bell" });
  assert.ok(api.state.csrfSeen.length > 0 && api.state.csrfSeen.every((t) => typeof t === "string" && t.startsWith("stub-csrf-")));
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll at 390 px");
  assert.deepEqual(problems, []);
  await context.close();
});

test("DEVOS-77 DL AT9: the failed-runs page lists dead letters escaped and retries one with CSRF", async () => {
  const refusedBefore = api.state.csrfRefused ?? 0;
  const { page, context, problems } = await open("/dead-letters");
  await page.getByTestId("dead-letters").waitFor();
  assert.equal(await page.getByTestId("dead-letter").count(), 2);
  const first = await page.getByTestId("dead-letter").first().innerText();
  assert.match(first, /run-7/);
  assert.match(first, /3 attempts/);
  assert.match(first, /<img src=x onerror=window.__xss2=1>/, "the reason is shown as text");
  assert.equal(await page.evaluate(() => window.__xss2), undefined, "a reason never runs as script");
  assert.match(await page.getByTestId("dead-letter").nth(1).innerText(), /time unknown/);
  await page.getByTestId("retry-run-7").click();
  await page.getByTestId("notice").filter({ hasText: "Run run-7 queued again." }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="dead-letter"]').length === 1);
  const writes = api.state.received.filter((r) => r.url.startsWith("/runs/"));
  assert.deepEqual(writes.map((w) => w.url), ["/runs/dead-letters/run-7/retry"]);
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "the retry carried the session's CSRF token");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll at 390 px");
  assert.deepEqual(problems, []);
  await context.close();
});
