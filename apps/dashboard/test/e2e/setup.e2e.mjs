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

test("DEVOS-176 AT-CA9: the settings screen turns the analyst model pass on and off (default off)", async () => {
  const { page, context, problems } = await open("/settings");
  await page.getByTestId("settings-form").waitFor();
  const box = page.getByTestId("analyst-model-pass");
  assert.equal(await box.isChecked(), false);
  await box.check();
  await page.getByTestId("save-settings").click();
  await page.getByTestId("notice").filter({ hasText: "Settings saved." }).waitFor();
  assert.equal(JSON.parse(api.state.received.filter((r) => r.url === "/settings").at(-1).body).analystModelPass, true);
  assert.equal(await box.isChecked(), true);
  const before = api.state.received.filter((r) => r.url === "/settings").length;
  await box.uncheck();
  await page.getByTestId("save-settings").click();
  for (let i = 0; i < 100 && api.state.received.filter((r) => r.url === "/settings").length === before; i++) await page.waitForTimeout(50);
  assert.equal(JSON.parse(api.state.received.filter((r) => r.url === "/settings").at(-1).body).analystModelPass, false);
  assert.equal(await box.isChecked(), false);
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
  assert.equal(sent.analystModelPass, false);
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

test("M2.3 AT12 (DEVOS-135): the approvals inbox lists pending first, escapes card text, comments and approves with CSRF", async () => {
  const refusedBefore = api.state.csrfRefused ?? 0;
  const { page, context, problems } = await open("/approvals");
  await page.getByTestId("approvals").waitFor();
  await page.getByTestId("nav-pending").filter({ hasText: "(2 pending)" }).waitFor();
  const rows = page.getByTestId("approval-row");
  assert.equal(await rows.count(), 4, "both pending cards, then the first page (2) of rejected cards");
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status"))), ["pending", "pending", "rejected", "rejected"], "pending cards come first, even the oldest");
  await page.getByTestId("approvals-more").click();
  await rows.nth(4).waitFor();
  assert.match(await rows.nth(4).innerText(), /oldest reject/, "Show more reads the next page of decided cards");
  assert.equal(await page.getByTestId("approvals-more").count(), 0, "no more pages, no button");
  assert.ok(api.state.approvalReads.some((u) => u.includes("status=rejected") && u.includes("cursor=")), "decided cards are paged by status");
  assert.match(await rows.first().innerText(), /<img src=x onerror=window.__xss3=1>/, "the action is shown as text");
  assert.match(await rows.first().innerText(), /\$2\.50 · 1 blocked task\b/);
  await page.getByTestId("open-00000000-0000-4000-8000-0000000000a1").click();
  await page.getByTestId("approval-detail").waitFor();
  assert.match(await page.getByTestId("approval-detail").innerText(), /Deploy shop <b>live<\/b>/, "task titles are text");
  await page.getByTestId("comment-body").fill("ok <script>window.__xss4=1</script>");
  await page.getByTestId("comment-send").click();
  await page.getByTestId("comments").filter({ hasText: "window.__xss4" }).waitFor();
  await page.getByTestId("approve-uses").fill("2");
  await page.getByTestId("approve").click();
  await page.getByTestId("detail-status").filter({ hasText: "approved" }).waitFor();
  assert.match(await page.getByTestId("detail-grant").innerText(), /0\/2 uses/);
  assert.equal(await page.getByTestId("approve").count(), 0, "a decided card has no Approve");
  await page.getByTestId("nav-pending").filter({ hasText: "(1 pending)" }).waitFor();
  const writes = api.state.received.filter((r) => r.url.startsWith("/approvals/"));
  assert.deepEqual(writes.map((w) => w.url), ["/approvals/00000000-0000-4000-8000-0000000000a1/comments", "/approvals/00000000-0000-4000-8000-0000000000a1/approve"]);
  assert.deepEqual(JSON.parse(writes[1].body), { expiresInHours: 72, maxUses: 2 });
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "every POST carried the session's CSRF token");
  assert.equal(await page.evaluate(() => [window.__xss3, window.__xss4]).then((v) => v.every((x) => x === undefined)), true, "card text never runs as script");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll at 390 px");
  assert.deepEqual(problems, []);
  await context.close();
});

test("M2.3 AT12 (DEVOS-135): a deep-linked purge card shows the phrase to type and Reject sends its comment with CSRF", async () => {
  const refusedBefore = api.state.csrfRefused ?? 0;
  const A3 = "00000000-0000-4000-8000-0000000000a3";
  const { page, context, problems } = await open(`/approvals?id=${A3}`);
  await page.getByTestId("approval-detail").waitFor();
  assert.equal(await page.getByTestId("purge-phrase").innerText(), "PURGE project:old", "the exact phrase is shown");
  assert.equal(await page.getByTestId("approve-phrase").inputValue(), "", "the phrase is never prefilled");
  await page.getByTestId("reject-comment").fill("not now");
  await page.getByTestId("reject").click();
  await page.getByTestId("detail-status").filter({ hasText: "rejected" }).waitFor();
  assert.equal(await page.getByTestId("reject").count(), 0, "a decided card has no Reject");
  const last = api.state.received.at(-1);
  assert.equal(last.url, `/approvals/${A3}/reject`);
  assert.deepEqual(JSON.parse(last.body), { comment: "not now" });
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "the reject carried the session's CSRF token");
  await page.getByTestId("nav-pending").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("nav-approvals").innerText(), "Approvals", "no pending cards: the count is gone");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();
});

test("DEVOS-110: the probe's grant card shows its fixed grant, has no hours/uses inputs and approves with an empty body", async () => {
  const P = "00000000-0000-4000-8000-0000000000a6";
  api.state.approvals.push({ id: P, gate: "destructive_or_spend", action: "teardown.probe-grant", target: "project:00000000-0000-4000-8000-0000000000b1", reason: "DevOS runs a weekly self-test.", consequence: "Nothing is deleted except the probe's own test resources.", costUsd: null, projectId: null, status: "pending", createdAt: "2026-11-13T10:00:00.000Z", decidedAt: null, decidedBy: null, blockedTasks: 0, grant: null });
  const refusedBefore = api.state.csrfRefused ?? 0;
  const { page, context, problems } = await open(`/approvals?id=${P}`);
  await page.getByTestId("approval-detail").waitFor();
  assert.match(await page.getByTestId("approve-fixed").innerText(), /90 days, at most 30 uses/);
  assert.equal(await page.getByTestId("approve-hours").count(), 0, "no hours input for the fixed grant");
  assert.equal(await page.getByTestId("approve-uses").count(), 0, "no uses input for the fixed grant");
  await page.getByTestId("approve").click();
  await page.getByTestId("detail-status").filter({ hasText: "approved" }).waitFor();
  const last = api.state.received.at(-1);
  assert.equal(last.url, `/approvals/${P}/approve`);
  assert.deepEqual(JSON.parse(last.body), {});
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "the approve carried the session's CSRF token");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();
});

test("AT-CA3b (CR-a3, DEVOS-199): the project page shows the pre-flight read-only — waiting for secrets, answers and defaults, escaped", async () => {
  const { page, context, problems } = await open("/projects/xss-probe");
  await page.getByTestId("preflight-state").waitFor();
  assert.match(await page.getByTestId("preflight-state").innerText(), /Intake card approved\. The build has not started\./);
  assert.match(await page.getByTestId("preflight-waiting").innerText(), /waiting for secrets: SMS_API_KEY/);
  const items = await page.getByTestId("preflight-item").allInnerTexts();
  assert.equal(items.length, 3);
  assert.match(items[0], /PF-1 Who pays for SMS\? <img src=x onerror=window\.__xss3=1>/, "spec text is shown as text");
  assert.match(items[0], /Your answer: the client <b>pays<\/b>/);
  assert.match(items[1], /Default used: USD 15/);
  assert.match(items[2], /PF-3 secret SMS_API_KEY \(missing\)/);
  assert.equal(await page.evaluate(() => window.__xss3), undefined, "no payload ran");
  assert.equal(await page.locator('[data-testid="preflight-panel"] img, [data-testid="preflight-panel"] b').count(), 0);
  assert.equal(await page.locator("button", { hasText: /approve|reject/i }).count(), 0, "read-only: no decision controls");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();
  // Another project with no pre-flight on the stub: a fixed message, never raw error text.
  const other = await open("/projects/social-content-extraction");
  await other.page.getByTestId("preflight-error").waitFor();
  assert.match(await other.page.getByTestId("preflight-error").innerText(), /^No pre-flight for this project yet .*\(project-not-found\)$/);
  await other.context.close();
  // Signed out (not KK's device): the sign-in line, and no pre-flight read.
  api.state.denySignIn = true;
  try {
    const out = await open("/projects/xss-probe");
    await out.page.getByTestId("preflight-error").waitFor();
    assert.match(await out.page.getByTestId("preflight-error").innerText(), /not signed in to the tailnet as KK\. \(not-kk\)$/);
    assert.equal(await out.page.getByTestId("preflight-item").count(), 0);
    await out.context.close();
  } finally {
    api.state.denySignIn = false;
  }
});

test("M2.4-d2 (DEVOS-225): the project page's Provisioning panel shows each step in plain words, escaped, and Try again posts the retry with CSRF", async () => {
  const refusedBefore = api.state.csrfRefused ?? 0;
  const { page, context, problems } = await open("/projects/xss-probe");
  await page.getByTestId("provisioning-step").first().waitFor();
  const steps = await page.getByTestId("provisioning-step").allInnerTexts();
  assert.equal(steps.length, 2);
  assert.match(steps[0], /github\/repo — needs your decision: something with this name already exists/);
  assert.match(steps[1], /github\/core — waiting \(<img src=x onerror=window\.__xss4=1>\)/, "a code is shown as text");
  assert.equal(await page.evaluate(() => window.__xss4), undefined, "no payload ran");
  assert.equal(await page.locator('[data-testid="provisioning-panel"] img').count(), 0);
  await page.getByTestId("provisioning-retry").click();
  await page.getByTestId("provisioning-note").filter({ hasText: "Queued" }).waitFor();
  assert.equal(api.state.received.at(-1).url, "/projects/11111111-1111-4111-8111-111111111111/provision");
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "the retry carried the session's CSRF token");
  await page.getByTestId("provisioning-retry").waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();
  const other = await open("/projects/social-content-extraction");
  await other.page.getByTestId("provisioning-error").waitFor();
  assert.match(await other.page.getByTestId("provisioning-error").innerText(), /^Provisioning has not started for this project\. \(project-not-found\)$/);
  await other.context.close();
});

test("AT8a/AT11 page part (CR-b2c, DEVOS-216): the project page lists every batch question, its answer, and a rejected card's stopped tasks, escaped", async () => {
  const { page, context, problems } = await open("/projects/xss-probe");
  await page.getByTestId("batch").first().waitFor();
  const batches = page.getByTestId("batch");
  assert.equal(await batches.count(), 2);
  const today = batches.nth(0);
  const qs = await today.getByTestId("batch-question").allInnerTexts();
  assert.equal(qs.length, 12, "AT8a: all 12 questions are listed, not only the clipped card reason");
  assert.match(qs[0], /^BQ-1 Use <img src=x onerror=window\.__xss4=1> icons\?/, "question text is shown as text");
  assert.match(qs[0], /Your answer: no <b>icons<\/b>/);
  assert.match(qs[11], /^BQ-12 Question 12: /);
  assert.match(qs[11], /Default used: Architect decides/);
  assert.match(await today.getByTestId("batch-state").innerText(), /Approved; the answers below were applied\./);
  assert.equal(await today.getByTestId("batch-stopped-task").count(), 0);
  const rejected = batches.nth(1);
  assert.match(await rejected.getByTestId("batch-state").innerText(), /Rejected\. The tasks below stay stopped\./);
  assert.deepEqual(await rejected.getByTestId("batch-stopped-task").allInnerTexts(), ["Build search <script>window.__xss5=1</script>", "Index the catalogue"]);
  assert.match(await rejected.getByTestId("batch-question").innerText(), /Default: no/);
  assert.match(await page.getByTestId("batches-waiting").innerText(), /^1 question will join the next daily card\.$/);
  assert.equal(await page.evaluate(() => [window.__xss4, window.__xss5]).then((v) => v.every((x) => x === undefined)), true, "no payload ran");
  assert.equal(await page.locator('[data-testid="batches-panel"] img, [data-testid="batches-panel"] b, [data-testid="batches-panel"] script').count(), 0);
  assert.equal(await page.locator('[data-testid="batches-panel"] button').count(), 0, "read-only: no decision controls");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();
  const other = await open("/projects/social-content-extraction");
  await other.page.getByTestId("batches-error").waitFor();
  assert.match(await other.page.getByTestId("batches-error").innerText(), /^No build questions for this project yet\. \(project-not-found\)$/);
  await other.context.close();
});

test("M2.5-b3 (DEVOS-246, AT9 panel half): the Remove project panel shows the state in IST and the leftover check as text; Archive, Restore and Ask to delete now post with CSRF; no delete button", async () => {
  const refusedBefore = api.state.csrfRefused ?? 0;
  // Laptop width: the archived project.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  let probe401 = 0;
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/^Failed to load resource: the server responded with a status of 401/.test(m.text()) && probe401++ === 0) return;
    problems.push(`console: ${m.text()}`);
  });
  page.on("dialog", async (d) => { problems.push(`dialog: ${d.message()}`); await d.dismiss(); });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(dash.base + "/projects/xss-probe", { waitUntil: "load" });
  const panel = page.getByTestId("remove-panel");
  await panel.getByTestId("remove-state").waitFor();
  assert.match(await panel.getByTestId("remove-state").innerText(), /^Archived since 10 Nov 2026, 10:00 IST: .* after 10 Dec 2026, 10:00 IST\.$/);
  assert.equal(await panel.getByTestId("remove-counts").innerText(), "Coolify: 2, GitHub: 1");
  assert.match(await panel.getByTestId("remove-scan-hit").innerText(), /^still there: Coolify application “<img src=x onerror=window\.__xss6=1>” \(app-<b>1<\/b>\)$/);
  assert.match(await panel.getByTestId("remove-scan-error").innerText(), /^could not check github<script>window\.__xss7=1<\/script> \(provider_error\)$/);
  assert.equal(await panel.locator("img, b, script").count(), 0, "scan texts are shown as text");
  assert.equal(await page.evaluate(() => [window.__xss6, window.__xss7].every((x) => x === undefined)), true, "no payload ran");
  // No direct delete button anywhere in the panel.
  const labels = await panel.locator("button").allInnerTexts();
  assert.deepEqual(labels, ["Restore", "Ask to delete now"]);
  assert.ok(!labels.some((l) => /^(delete|purge)/i.test(l)));

  await panel.getByTestId("remove-ask-purge").click();
  await panel.getByTestId("remove-note").filter({ hasText: "The delete card is in Approvals" }).waitFor();
  assert.equal(api.state.received.at(-1).url, "/projects/11111111-1111-4111-8111-111111111111/purge-request");
  const link = panel.getByTestId("remove-card-link");
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), "/approvals?id=00000000-0000-4000-8000-0000000000a3");
  assert.equal(await panel.getByTestId("remove-ask-purge").count(), 0, "one card at a time");

  await panel.getByTestId("remove-restore").click();
  await panel.getByTestId("remove-note").filter({ hasText: "Restored." }).waitFor();
  assert.equal(api.state.received.at(-1).url, "/projects/11111111-1111-4111-8111-111111111111/restore");
  await panel.getByTestId("remove-archive").waitFor();
  assert.match(await panel.getByTestId("remove-state").innerText(), /^Active\./);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems, []);
  await context.close();

  // Phone width: the active project; Archive needs a second, in-page confirmation (no browser dialog).
  const { page: phone, context: pc, problems: pp } = await open("/projects/social-content-extraction");
  const pp2 = phone.getByTestId("remove-panel");
  await pp2.getByTestId("remove-archive").waitFor();
  assert.equal(await pp2.getByTestId("remove-scan").innerText(), "none yet");
  const posts = api.state.received.length;
  await pp2.getByTestId("remove-archive").click();
  assert.match(await pp2.getByTestId("remove-confirm").innerText(), /^Archive social-content-extraction\? .*Nothing is deleted\./);
  await pp2.getByTestId("remove-archive-cancel").click();
  assert.equal(api.state.received.length, posts, "Cancel posts nothing");
  await pp2.getByTestId("remove-archive").click();
  await pp2.getByTestId("remove-archive-confirm").click();
  await pp2.getByTestId("remove-note").filter({ hasText: "Archived. Nothing was deleted" }).waitFor();
  assert.equal(api.state.received.at(-1).url, "/projects/22222222-2222-4222-8222-222222222222/archive");
  await pp2.getByTestId("remove-restore").waitFor();
  assert.match(await pp2.getByTestId("remove-state").innerText(), /^Archived since 16 Nov 2026, 23:30 IST/);
  const m = await phone.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
  const box = await pp2.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the panel fits the phone width");
  assert.equal(api.state.csrfRefused ?? 0, refusedBefore, "every POST carried the session's CSRF token");
  assert.deepEqual(await phone.evaluate(() => window.__cspViolations), []);
  // The other panels on this page get the API's expected 404 project-not-found (no pre-flight, provisioning or batches).
  assert.deepEqual(pp.filter((p) => !/status of 404 \(Not Found\)$/.test(p)), []);
  await pc.close();
});

test("M2.6-b2b3 (DEVOS-248): Open in Linear links for the project and modules with a stored id, linear.app only, escaped, at phone and laptop width", async () => {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
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
    await page.goto(dash.base + "/projects/xss-probe", { waitUntil: "load" });
    const panel = page.getByTestId("linear-panel");
    const project = panel.getByTestId("linear-project-link");
    await project.waitFor();
    assert.equal(await project.getAttribute("href"), "https://linear.app/kishoremb/project/xss-probe-0f1e2d3c4b5a");
    assert.equal(await project.getAttribute("rel"), "noreferrer noopener");
    const links = panel.getByTestId("linear-module-link");
    assert.equal(await links.count(), 2, "the javascript: and look-alike host links are dropped");
    assert.deepEqual(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href"))),
      ["https://linear.app/kishoremb/issue/DEVOS-301/m11", "https://linear.app/kishoremb/issue/DEVOS-302/m12"]);
    assert.equal(await links.nth(1).innerText(), "Open M1.2<img src=x onerror=window.__xss8=1> in Linear", "module key shown as text");
    assert.equal(await panel.locator("img, script").count(), 0);
    assert.equal(await page.evaluate(() => [window.__xss8, window.__xss9].every((x) => x === undefined)), true, "no payload ran");
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(m.sw <= m.cw, `${width}: scrollWidth ${m.sw} > ${m.cw}`);
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${width}: the panel fits`);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
    assert.deepEqual(problems, []);
    await context.close();
  }

  // A project with the mirror off: no link at all (a module without a stored id is dropped by the API, linear-links.test.mjs).
  const { page, context, problems } = await open("/projects/social-content-extraction");
  const panel = page.getByTestId("linear-panel");
  await panel.getByTestId("linear-off").waitFor();
  assert.equal(await panel.locator("a").count(), 0, "no link while the mirror is off");
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(problems.filter((p) => !/status of 404 \(Not Found\)$/.test(p)), []);
  await context.close();
});
