// M1.6 acceptance tests (docs/modules/M1.6.md): one notice reaches the dashboard feed, the MyBrain
// bell (HMAC-signed, timestamped) and email (SMTP), each channel with its own status.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createApp } from "../dist/app.js";
import { KkSessionRegistry } from "../dist/auth.js";
import { loadConfig, startupErrorCode } from "../dist/config.js";
import { buildRuntime } from "../dist/runtime.js";
import {
  MemoryNotificationStore,
  Notifier,
  PrismaNotificationStore,
  bellPayload,
  checkBellUrl,
  parseNotice,
  signBell,
} from "../dist/notify.js";
import { SECRET_NAMES } from "../dist/vault.js";
import { isPublicAddress } from "../dist/bell.js";
import { buildMessage, encodeHeader, parseSmtpConfig, sendMail } from "../dist/smtp.js";

const KK = "kk@example.com";
const ORIGIN = "http://devos:3000";
const ENV = { DEVOS_KK_LOGIN: KK, DEVOS_SESSION_KEY: "test-only-session-key-0123456789abcdef", DEVOS_ALLOWED_ORIGINS: ORIGIN };
const BELL_KEY = "TESTONLY-bell-key-0123456789abcdef0123456789";
const SMTP_PASS = "TESTONLY-smtp-pass-9f8e7d6c5b4a";

/** The vault as the notifier sees it (M1.4 `Vault.reveal` + metadata). */
const vaultWith = (values) => ({ reveal: async (n) => values[n] ?? null, isSet: async (n) => values[n] !== undefined });
const VAULT = vaultWith({ mybrain_bell_key: BELL_KEY, smtp_password: SMTP_PASS });

/** A stub MyBrain bell: verifies signature and timestamp like the MyBrain receiver must. */
async function stubBell({ status = 204, hang = false } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ts = Number(req.headers["x-devos-timestamp"]);
      const sig = String(req.headers["x-devos-signature"] ?? "");
      const want = "v1=" + createHmac("sha256", BELL_KEY).update(`${ts}.${body}`).digest("hex");
      const valid = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      received.push({ headers: req.headers, body, json: JSON.parse(body), valid, ts });
      if (hang) return;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("upstream says: internal detail that must never be stored");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api/bell`, received, close: () => (server.closeAllConnections(), server.close()) };
}

/** A stub SMTP relay on loopback (plaintext, allowed only to loopback). */
async function stubSmtp({ rcpt = 250, starttls = false } = {}) {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let data = false;
    let cur = { auth: null, from: null, to: null, data: "" };
    sock.write("220 stub ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          data = false;
          mails.push(cur);
          cur = { auth: null, from: null, to: null, data: "" };
          sock.write("250 queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) sock.write(`250-stub\r\n${starttls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`);
        else if (/^AUTH PLAIN /.test(line)) (cur.auth = Buffer.from(line.slice(11), "base64").toString()), sock.write("235 ok\r\n");
        else if (/^MAIL FROM:/.test(line)) (cur.from = line), sock.write("250 ok\r\n");
        else if (/^RCPT TO:/.test(line)) (cur.to = line), sock.write(rcpt === 250 ? "250 ok\r\n" : `${rcpt} 5.1.1 secret-internal-reason\r\n`);
        else if (line === "DATA") (data = true), sock.write("354 go\r\n");
        else if (line === "QUIT") sock.end("221 bye\r\n");
        else sock.write("502 no\r\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { host: "127.0.0.1", port: server.address().port, security: "plain", user: "devos", pass: null, from: "devos@example.org" };
  return { cfg, mails, close: () => server.close() };
}

async function start({ notifier, store } = {}) {
  const logs = [];
  const app = await createApp({
    config: loadConfig(ENV),
    identity: { whois: async () => ({ login: KK, node: "kk-laptop" }) },
    log: (e) => logs.push(e),
    kkSessions: new KkSessionRegistry(),
    notify: { notifier: notifier ?? null },
  });
  await app.listen(0, "127.0.0.1");
  return { app, port: app.getHttpServer().address().port, logs, store };
}

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : undefined, text }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function kk(port) {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/auth/session", headers: { origin: ORIGIN } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(t) }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(r.status, 201);
  const cookie = r.headers["set-cookie"][0].split(";")[0];
  const h = { cookie, origin: ORIGIN, "x-devos-csrf": r.json.csrfToken };
  return {
    cookie,
    get: (p) => call(port, "GET", p, { headers: { cookie } }),
    put: (p, body, extra = {}) => call(port, "PUT", p, { headers: { ...h, ...extra }, body }),
    post: (p, body, extra = {}) => call(port, "POST", p, { headers: { ...h, ...extra }, body }),
  };
}

function notifierWith(store, bell, smtp, extra = {}) {
  return new Notifier(store, {
    secrets: VAULT,
    smtp: smtp?.cfg ?? null,
    dashboardUrl: "https://devos.example.ts.net",
    timeoutMs: 2000,
    allowLoopbackHttp: true,
    ...extra,
  });
}

async function configure(api, bell) {
  assert.equal((await api.put("/notifications/channels/mybrain", { target: bell.url })).status, 200);
  assert.equal((await api.put("/notifications/channels/email", { target: "kk@example.com" })).status, 200);
}

test("M1.6 AT1 (done when): one test card reaches the dashboard, the MyBrain bell and email", async () => {
  const bell = await stubBell();
  const smtp = await stubSmtp();
  const store = new MemoryNotificationStore();
  const s = await start({ notifier: notifierWith(store, bell, smtp) });
  try {
    const api = await kk(s.port);
    await configure(api, bell);
    const r = await api.post("/notifications/test");
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(
      r.json.deliveries.map((d) => [d.channel, d.status, d.error]).sort(),
      [["dashboard", "sent", null], ["email", "sent", null], ["mybrain", "sent", null]],
    );
    // Dashboard feed
    const feed = await api.get("/notifications");
    assert.equal(feed.status, 200);
    assert.equal(feed.json.notices.length, 1);
    assert.equal(feed.json.notices[0].id, r.json.notice.id);
    assert.equal(feed.json.notices[0].kind, "test");
    assert.ok(feed.json.notices[0].deliveries.every((d) => d.status === "sent"));
    // MyBrain bell: signed, timestamped, the documented payload
    assert.equal(bell.received.length, 1);
    const b = bell.received[0];
    assert.equal(b.valid, true, "HMAC signature verifies");
    assert.ok(Math.abs(b.ts - Date.now() / 1000) < 60, "timestamp is current");
    assert.equal(b.headers["x-devos-notice-id"], r.json.notice.id);
    assert.deepEqual(Object.keys(b.json).sort(), ["createdAt", "id", "kind", "link", "reasons", "source", "summary", "title", "v"]);
    assert.equal(b.json.link, `https://devos.example.ts.net/notifications#${r.json.notice.id}`);
    // Email: one message to the recipient, authenticated, subject and body
    assert.equal(smtp.mails.length, 1);
    const m = smtp.mails[0];
    assert.equal(m.to, "RCPT TO:<kk@example.com>");
    assert.equal(m.from, "MAIL FROM:<devos@example.org>");
    assert.equal(m.auth, `\0devos\0${SMTP_PASS}`);
    assert.match(m.data, /^Subject: \[DevOS\] DevOS test card$/m);
    const text = Buffer.from(m.data.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.match(text, /test notice from DevOS/);
    assert.match(text, /Reasons:\n- Sent from the dashboard notifications page/);
    // Rows: one per channel, all sent, attempts 1
    assert.equal(store.rows.length, 3);
    assert.ok(store.rows.every((x) => x.status === "sent" && x.attempts === 1 && x.sentAt));
    // Nothing secret in any response or log
    const out = JSON.stringify([r.json, feed.json, s.logs]);
    for (const secret of [BELL_KEY, SMTP_PASS]) assert.ok(!out.includes(secret));
  } finally {
    await s.app.close();
    bell.close();
    smtp.close();
  }
});

test("M1.6 AT2 (Phase PS amendment): a standard-selection notice reaches the dashboard and the bell with its reasons", async () => {
  const bell = await stubBell();
  const store = new MemoryNotificationStore();
  const n = notifierWith(store, bell, null);
  await store.setChannel("mybrain", { target: bell.url }, { action: "x", summary: "x", details: {} });
  await store.setChannel("email", { enabled: false }, { action: "x", summary: "x", details: {} });
  try {
    assert.equal(parseNotice({ kind: "standard_selection", title: "Standard selection" }), "missing:reasons");
    const input = parseNotice({
      kind: "standard_selection",
      title: "Standard selection for pilot",
      body: "Selected modules: SM-02, SM-05.",
      reasons: ["Spec mentions uploads → B03", "LLM SDK import → B02"],
    });
    assert.equal(typeof input, "object");
    const { notice, deliveries } = await n.notify(input);
    assert.deepEqual(deliveries.map((d) => [d.channel, d.status]).sort(), [["dashboard", "sent"], ["mybrain", "sent"]]);
    const feed = await store.feed(50);
    assert.deepEqual(feed[0].reasons, ["Spec mentions uploads → B03", "LLM SDK import → B02"]);
    assert.equal(feed[0].kind, "standard_selection");
    assert.equal(bell.received[0].json.kind, "standard_selection");
    assert.deepEqual(bell.received[0].json.reasons, input.reasons);
    assert.equal(bell.received[0].json.id, notice.id);
    assert.equal(bell.received[0].valid, true);
  } finally {
    bell.close();
  }
});

test("M1.6 AT3: notices never carry secrets; the bell payload is a fixed shape with a shortened body", () => {
  const ok = { kind: "info", title: "Hi" };
  for (const leak of ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAA", "ghp_abcdefghijklmnopqrstuvwxyz0123", "lin_api_abcdefghijklmnopqrstu", "password: hunter22", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.equal(parseNotice({ ...ok, body: leak }), "notice-contains-secret", leak);
    assert.equal(parseNotice({ ...ok, title: `x ${leak}`.slice(0, 120) }), "notice-contains-secret", leak);
    assert.equal(parseNotice({ ...ok, reasons: [leak] }), "notice-contains-secret", leak);
  }
  for (const [body, code] of [
    [null, "body-must-be-object"],
    [[], "body-must-be-object"],
    [{ ...ok, kind: "spam" }, "invalid:kind"],
    [{ ...ok, title: "" }, "invalid:title"],
    [{ ...ok, title: "x".repeat(121) }, "invalid:title"],
    [{ ...ok, title: "a\r\nBcc: x@y.z" }, "invalid:title"],
    [{ ...ok, body: "x".repeat(2001) }, "invalid:body"],
    [{ ...ok, body: "nul\0" }, "invalid:body"],
    [{ ...ok, reasons: Array(11).fill("r") }, "invalid:reasons"],
    [{ ...ok, reasons: [""] }, "invalid:reasons"],
    [{ ...ok, projectId: "nope" }, "invalid:projectId"],
    [{ ...ok, extra: 1 }, "unknown-field:extra"],
  ]) {
    assert.equal(parseNotice(body), code, JSON.stringify(body));
  }
  const n = { id: "11111111-1111-4111-8111-111111111111", kind: "info", title: "T", body: "b".repeat(900), reasons: ["r"], projectId: "22222222-2222-4222-8222-222222222222", approvalId: null, createdAt: "2026-11-06T10:00:00.000Z" };
  const p = bellPayload(n, null);
  assert.equal(p.summary.length, 500);
  assert.equal(p.link, null);
  assert.ok(!("projectId" in p) && !("body" in p), "only the documented fields leave the server");
  // Signature: over "<ts>.<body>"; a changed body or timestamp does not verify.
  const key = Buffer.from(BELL_KEY);
  const sig = signBell(key, 1700000000, '{"a":1}');
  assert.match(sig, /^v1=[0-9a-f]{64}$/);
  assert.notEqual(signBell(key, 1700000001, '{"a":1}'), sig);
  assert.notEqual(signBell(key, 1700000000, '{"a":2}'), sig);
});

test("M1.6 AT4: a failing channel is recorded with a fixed code and never stops the others", async () => {
  const bell500 = await stubBell({ status: 500 });
  const hang = await stubBell({ hang: true });
  const smtp = await stubSmtp({ rcpt: 550 });
  try {
    const store = new MemoryNotificationStore();
    const n = notifierWith(store, bell500, smtp);
    await store.setChannel("mybrain", { target: bell500.url }, { action: "x", summary: "x", details: {} });
    await store.setChannel("email", { target: "kk@example.com" }, { action: "x", summary: "x", details: {} });
    const r = await n.notify(parseNotice({ kind: "info", title: "Failing channels" }));
    const by = Object.fromEntries(r.deliveries.map((d) => [d.channel, d]));
    assert.equal(by.dashboard.status, "sent");
    assert.deepEqual([by.mybrain.status, by.mybrain.error], ["failed", "mybrain-http-500"]);
    assert.deepEqual([by.email.status, by.email.error], ["failed", "email-recipient-refused"]);
    assert.ok(!JSON.stringify(store.rows).includes("internal"), "no upstream text is stored");
    assert.ok(store.rows.filter((x) => x.status === "failed").every((x) => x.attempts === 1));

    // A bell that never answers ends at the deadline.
    const store2 = new MemoryNotificationStore();
    const n2 = notifierWith(store2, hang, null, { timeoutMs: 300 });
    await store2.setChannel("mybrain", { target: hang.url }, { action: "x", summary: "x", details: {} });
    await store2.setChannel("email", { enabled: false }, { action: "x", summary: "x", details: {} });
    const t0 = Date.now();
    const r2 = await n2.notify(parseNotice({ kind: "info", title: "Slow bell" }));
    assert.ok(Date.now() - t0 < 2000);
    assert.deepEqual(r2.deliveries.find((d) => d.channel === "mybrain").error, "mybrain-timeout");
    // A redirect is not followed.
    const redir = http.createServer((_q, res) => (res.writeHead(302, { location: "http://169.254.169.254/" }), res.end()));
    await new Promise((ok) => redir.listen(0, "127.0.0.1", ok));
    const store3 = new MemoryNotificationStore();
    const n3 = notifierWith(store3, null, null);
    await store3.setChannel("mybrain", { target: `http://127.0.0.1:${redir.address().port}/bell` }, { action: "x", summary: "x", details: {} });
    const r3 = await n3.notify(parseNotice({ kind: "info", title: "Redirect" }));
    assert.equal(r3.deliveries.find((d) => d.channel === "mybrain").error, "mybrain-http-302", "a redirect is not followed");
    redir.close();
    // An SMTP server that never greets ends at the deadline.
    const mute = net.createServer(() => {});
    await new Promise((ok) => mute.listen(0, "127.0.0.1", ok));
    const code = await sendMail({ ...smtp.cfg, pass: SMTP_PASS, port: mute.address().port }, { to: "kk@example.com", subject: "s", text: "t", messageId: "m" }, 300);
    assert.equal(code, "email-timeout");
    mute.close();
  } finally {
    bell500.close();
    hang.close();
    smtp.close();
  }
});

test("M1.6 AT5: channel settings are validated and audited; nothing changes on a 400", async () => {
  const store = new MemoryNotificationStore();
  const n = new Notifier(store, { secrets: null, smtp: null, dashboardUrl: null, timeoutMs: 1000 });
  const s = await start({ notifier: n });
  try {
    const api = await kk(s.port);
    for (const [kind, body, code] of [
      ["mybrain", { target: "http://my-brain.example.com/bell" }, "invalid:target-https-only"],
      ["mybrain", { target: "https://10.0.0.5/bell" }, "invalid:target-host"],
      ["mybrain", { target: "https://localhost/bell" }, "invalid:target-host"],
      ["mybrain", { target: "https://[::1]/bell" }, "invalid:target-host"],
      ["mybrain", { target: "https://user:pw@my-brain.example.com/bell" }, "invalid:target"],
      ["mybrain", { target: "not a url" }, "invalid:target"],
      ["email", { target: "kk@example.com\r\nBcc: x@evil.test" }, "invalid:target"],
      ["email", { target: "no-at-sign" }, "invalid:target"],
      ["dashboard", { target: "x" }, "invalid:target"],
      ["mybrain", { enabled: "yes" }, "invalid:enabled"],
      ["mybrain", {}, "body-empty"],
      ["mybrain", { url: "https://x.example" }, "unknown-field:url"],
      ["sms", { enabled: true }, "invalid:kind"],
    ]) {
      const r = await api.put(`/notifications/channels/${kind}`, body);
      assert.equal(r.status, 400, `${kind} ${JSON.stringify(body)}`);
      assert.equal(r.json.code, code);
    }
    assert.equal(store.audits.length, 0);
    const ok = await api.put("/notifications/channels/mybrain", { target: "https://my-brain.accelr8.in/api/devos/bell", enabled: true });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.channel, { kind: "mybrain", enabled: true, target: "https://my-brain.accelr8.in/api/devos/bell" });
    assert.deepEqual(store.audits[0].details, { channel: "mybrain", fields: ["enabled", "target"] });
    const list = await api.get("/notifications/channels");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.channels.map((c) => c.kind), ["dashboard", "mybrain", "email"]);
    // A failed audit leaves the channel unchanged (the store commits both or neither).
    store.failAudit = true;
    const bad = await api.put("/notifications/channels/email", { enabled: false });
    assert.equal(bad.status, 503);
    assert.equal(bad.json.code, "notifications-store-error");
    assert.equal((await store.channels()).find((c) => c.kind === "email").enabled, true);
  } finally {
    await s.app.close();
  }
});

test("M1.6 AT6: sending and channel changes need a session and pass CSRF; nothing is sent otherwise", async () => {
  const store = new MemoryNotificationStore();
  const s = await start({ notifier: new Notifier(store, { secrets: null, smtp: null, dashboardUrl: null, timeoutMs: 1000 }) });
  try {
    assert.equal((await call(s.port, "POST", "/notifications/test", { headers: { origin: ORIGIN } })).status, 401);
    assert.equal((await call(s.port, "GET", "/notifications")).status, 401);
    const api = await kk(s.port);
    for (const extra of [{ "x-devos-csrf": "wrong" }, { origin: "http://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const r = await api.post("/notifications/test", undefined, extra);
      assert.equal(r.status, 403, JSON.stringify(extra));
      const p = await api.put("/notifications/channels/email", { enabled: false }, extra);
      assert.equal(p.status, 403);
    }
    assert.equal(store.rows.length, 0);
    assert.equal(store.audits.length, 0);
  } finally {
    await s.app.close();
  }
});

test("M1.6 AT7: unconfigured channels fail with a code; without a database the routes answer 503", async () => {
  const store = new MemoryNotificationStore();
  await store.setChannel("mybrain", { target: "https://my-brain.accelr8.in/api/devos/bell" }, { action: "x", summary: "x", details: {} });
  const n = new Notifier(store, { secrets: null, smtp: null, dashboardUrl: null, timeoutMs: 1000 });
  const r = await n.notify(parseNotice({ kind: "info", title: "x" }));
  const by = Object.fromEntries(r.deliveries.map((d) => [d.channel, d.error]));
  assert.deepEqual(by, { dashboard: null, mybrain: "mybrain-not-configured", email: "email-not-configured" });
  assert.deepEqual(await n.configured(), { mybrain: false, email: false });
  // SMTP configured with a user, but no smtp_password in the vault: nothing is sent unauthenticated.
  const relay0 = await stubSmtp();
  const store0 = new MemoryNotificationStore();
  await store0.setChannel("email", { target: "kk@example.com" }, { action: "x", summary: "x", details: {} });
  const n0 = new Notifier(store0, { secrets: vaultWith({}), smtp: relay0.cfg, dashboardUrl: null, timeoutMs: 1000 });
  assert.deepEqual(await n0.configured(), { mybrain: false, email: false });
  const r0 = await n0.notify(parseNotice({ kind: "info", title: "x" }));
  assert.equal(r0.deliveries.find((d) => d.channel === "email").error, "email-not-configured");
  assert.equal(relay0.mails.length, 0);
  relay0.close();
  assert.deepEqual(await new Notifier(store0, { secrets: VAULT, smtp: relay0.cfg, dashboardUrl: null, timeoutMs: 1000 }).configured(), { mybrain: true, email: true });
  const relay = await stubSmtp();
  const n2 = new Notifier(new MemoryNotificationStore(), { secrets: VAULT, smtp: relay.cfg, dashboardUrl: null, timeoutMs: 1000 });
  const r2 = await n2.notify(parseNotice({ kind: "info", title: "x" }));
  relay.close();
  assert.deepEqual(Object.fromEntries(r2.deliveries.map((d) => [d.channel, d.error])), { dashboard: null, mybrain: "mybrain-no-target", email: "email-no-target" });

  const s = await start();
  try {
    const api = await kk(s.port);
    for (const [m, p] of [["get", "/notifications"], ["get", "/notifications/channels"], ["post", "/notifications/test"]]) {
      const x = await api[m](p);
      assert.equal(x.status, 503);
      assert.equal(x.json.code, "notifications-not-configured");
    }
  } finally {
    await s.app.close();
  }
  const rt = await buildRuntime({}, { outboundTimeoutMs: 1000, kkSessions: new KkSessionRegistry(), loadDb: async () => assert.fail("no db") });
  assert.equal(rt.notify.notifier, null);
});

test("M1.6 AT8: configuration is validated at start-up with a code, never the value", async () => {
  // The bell key and SMTP password are vault secrets, entered in the setup wizard (M1.4 amendment).
  assert.ok(SECRET_NAMES.includes("mybrain_bell_key") && SECRET_NAMES.includes("smtp_password"));
  const base = { DEVOS_SMTP_HOST: "smtp.example.org", DEVOS_SMTP_FROM: "devos@example.org", DEVOS_SMTP_USER: "u" };
  assert.equal(parseSmtpConfig({}), null);
  assert.deepEqual(parseSmtpConfig(base), { host: "smtp.example.org", port: 465, security: "tls", user: "u", pass: null, from: "devos@example.org" });
  assert.equal(parseSmtpConfig({ ...base, DEVOS_SMTP_SECURITY: "starttls" }).port, 587);
  for (const [env, code] of [
    [{ ...base, DEVOS_SMTP_SECURITY: "plain" }, "config-smtp-plain-not-loopback"],
    [{ ...base, DEVOS_SMTP_SECURITY: "ssl" }, "config-smtp-security-invalid"],
    [{ ...base, DEVOS_SMTP_PORT: "0" }, "config-smtp-port-invalid"],
    [{ ...base, DEVOS_SMTP_FROM: "nope" }, "config-smtp-from-invalid"],
    [{ ...base, DEVOS_SMTP_USER: "u\r\nx" }, "config-smtp-user-invalid"],
    [{ ...base, DEVOS_SMTP_HOST: "bad host" }, "config-smtp-host-invalid"],
  ]) {
    assert.throws(() => parseSmtpConfig(env), (e) => e.message === code && !e.message.includes(SMTP_PASS), code);
  }
  assert.equal(startupErrorCode(new Error("config-smtp-plain-not-loopback")), "config-smtp-plain-not-loopback");
  await assert.rejects(
    buildRuntime({ DEVOS_SMTP_HOST: "smtp.example.org", DEVOS_SMTP_FROM: "devos@example.org", DEVOS_SMTP_SECURITY: "plain" }, { outboundTimeoutMs: 1000, kkSessions: new KkSessionRegistry(), loadDb: async () => ({}) }),
    /config-smtp-plain-not-loopback/,
  );
  // checkBellUrl: https public host only (loopback http only with the test-only option)
  assert.equal(checkBellUrl("https://my-brain.accelr8.in/api/devos/bell"), null);
  assert.equal(checkBellUrl("http://127.0.0.1:9/bell"), "invalid:target-https-only");
  assert.equal(checkBellUrl("http://127.0.0.1:9/bell", true), null);
});

test("M1.6 AT9: email headers cannot be injected; STARTTLS is required when configured", async () => {
  assert.equal(encodeHeader("a\r\nBcc: evil@x.test"), "a Bcc: evil@x.test");
  assert.equal(encodeHeader("Grüße"), "=?UTF-8?B?R3LDvMOfZQ==?=");
  const cfg = { host: "127.0.0.1", port: 1, security: "plain", user: null, pass: null, from: "devos@example.org" };
  const msg = buildMessage(cfg, { to: "kk@example.com", subject: "x\r\nBcc: evil@x.test", text: ".\r\nQUIT", messageId: "abc" }, new Date(0));
  assert.equal(msg.match(/^Bcc:/m), null);
  assert.ok(!msg.split("\r\n").includes("."), "the body is base64, so it can never end the DATA section");
  assert.equal(await sendMail(cfg, { to: "a@b.c\r\nRCPT TO:<x@y.z>", subject: "s", text: "t", messageId: "m" }, 500), "email-no-target");
  const smtp = await stubSmtp();
  try {
    const code = await sendMail({ ...smtp.cfg, pass: SMTP_PASS, security: "starttls" }, { to: "kk@example.com", subject: "s", text: "t", messageId: "m" }, 2000);
    assert.equal(code, "email-starttls-unavailable");
    assert.equal(smtp.mails.length, 0, "nothing is sent without TLS");
  } finally {
    smtp.close();
  }
});

test("M1.6 AT10: every Prisma store method runs in a bounded transaction; the channel change and its audit share it", async () => {
  const calls = [];
  const tx = {
    notificationChannel: { findMany: async () => [], upsert: async ({ create }) => create },
    notification: { createMany: async () => ({}), updateMany: async () => ({}), findMany: async () => [] },
    auditEvent: { create: async () => calls.push("audit") },
  };
  const db = {
    $transaction: async (fn, opts) => {
      calls.push(opts);
      return fn(tx);
    },
  };
  const st = new PrismaNotificationStore(db, 1234);
  const notice = { id: "11111111-1111-4111-8111-111111111111", kind: "info", title: "t", body: "", reasons: [], projectId: null, approvalId: null, createdAt: new Date().toISOString() };
  await st.channels();
  await st.setChannel("email", { enabled: false }, { action: "a", summary: "s", details: {} });
  await st.create(notice, ["dashboard"], new Date());
  await st.record(notice.id, "email", "failed", "email-timeout", new Date());
  await st.feed(10);
  const opts = calls.filter((c) => typeof c === "object");
  assert.equal(opts.length, 5);
  assert.ok(opts.every((o) => o.timeout === 1234 && o.maxWait === 1234));
  assert.deepEqual(calls.slice(1, 3), [{ timeout: 1234, maxWait: 1234 }, "audit"]);
});

test("M1.6 AT13 (PR18-r1): notify() itself validates every notice; nothing is stored or sent for an invalid one", async () => {
  const bell = await stubBell();
  const store = new MemoryNotificationStore();
  await store.setChannel("mybrain", { target: bell.url }, { action: "x", summary: "x", details: {} });
  const n = notifierWith(store, bell, null);
  try {
    const base = { kind: "info", title: "T", body: "", reasons: [], projectId: null, approvalId: null };
    for (const [input, code] of [
      [{ ...base, body: "password: hunter22" }, "notice-contains-secret"],
      [{ ...base, kind: "standard_selection" }, "missing:reasons"],
      [{ ...base, title: "" }, "invalid:title"],
      [{ ...base, kind: "spam" }, "invalid:kind"],
    ]) {
      await assert.rejects(n.notify(input), (e) => e.code === code, code);
    }
    assert.equal(store.rows.length, 0);
    assert.equal(bell.received.length, 0);
  } finally {
    bell.close();
  }
});

test("M1.6 AT14 (PR18-r1): the bell never connects to a private address, whatever the name resolves to", async () => {
  for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "100.100.100.100", "172.16.1.1", "192.168.1.1", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:93.184.216.34"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const t of ["https://localhost./bell", "https://x.localhost/bell"]) {
    assert.equal(checkBellUrl(t), "invalid:target-host", t);
  }
  // A public-looking name that resolves to a private or mixed answer is refused before connecting.
  let connected = 0;
  const trap = http.createServer((_q, res) => (connected++, res.end()));
  await new Promise((ok) => trap.listen(0, "127.0.0.1", ok));
  try {
    for (const answer of [[{ address: "10.0.0.5", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], []]) {
      const store = new MemoryNotificationStore();
      await store.setChannel("mybrain", { target: `https://bell.example.com:${trap.address().port}/x` }, { action: "x", summary: "x", details: {} });
      await store.setChannel("email", { enabled: false }, { action: "x", summary: "x", details: {} });
      const n = new Notifier(store, { secrets: VAULT, smtp: null, dashboardUrl: null, timeoutMs: 1000, resolve: async () => answer });
      const r = await n.notify(parseNotice({ kind: "info", title: "x" }));
      assert.equal(r.deliveries.find((d) => d.channel === "mybrain").error, answer.length ? "mybrain-blocked-address" : "mybrain-dns");
    }
    assert.equal(connected, 0);
    // The connection is pinned to the checked address: a resolver answer is the only address used.
    const pinned = new Notifier(new MemoryNotificationStore(), { secrets: VAULT, smtp: null, dashboardUrl: null, timeoutMs: 1000, allowLoopbackHttp: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await pinned.store.setChannel("mybrain", { target: `http://localhost:${trap.address().port}/x` }, { action: "x", summary: "x", details: {} });
    await pinned.store.setChannel("email", { enabled: false }, { action: "x", summary: "x", details: {} });
    const ok = await pinned.notify(parseNotice({ kind: "info", title: "x" }));
    assert.equal(ok.deliveries.find((d) => d.channel === "mybrain").status, "sent");
    assert.equal(connected, 1);
  } finally {
    trap.close();
  }
});

test("M1.6 AT15 (PR18-r1): a delivery outcome that cannot be stored is a 503, never a 201", async () => {
  const bell = await stubBell();
  const store = new MemoryNotificationStore();
  await store.setChannel("mybrain", { target: bell.url }, { action: "x", summary: "x", details: {} });
  await store.setChannel("email", { enabled: false }, { action: "x", summary: "x", details: {} });
  store.record = async () => {
    throw new Error("db down: secret detail");
  };
  const s = await start({ notifier: notifierWith(store, bell, null) });
  try {
    const api = await kk(s.port);
    const r = await api.post("/notifications/test");
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "notifications-store-error");
    assert.ok(!r.text.includes("secret detail"));
    await assert.rejects(notifierWith(store, bell, null).notify(parseNotice({ kind: "info", title: "x" })), /notifications-store-error/);
  } finally {
    await s.app.close();
    bell.close();
  }
});

test("M1.6 AT16 (PR18-r1): with the dashboard channel off, notices and failed deliveries still appear in the feed", async () => {
  const store = new MemoryNotificationStore();
  await store.setChannel("dashboard", { enabled: false }, { action: "x", summary: "x", details: {} });
  await store.setChannel("mybrain", { target: "https://my-brain.accelr8.in/api/devos/bell" }, { action: "x", summary: "x", details: {} });
  const n = new Notifier(store, { secrets: null, smtp: null, dashboardUrl: null, timeoutMs: 1000 });
  const first = await n.notify(parseNotice({ kind: "info", title: "one" }));
  const second = await n.notify(parseNotice({ kind: "info", title: "two" }));
  const feed = await store.feed(50);
  assert.deepEqual(new Set(feed.map((f) => f.id)), new Set([first.notice.id, second.notice.id]));
  for (const f of feed) {
    assert.deepEqual(f.deliveries.map((d) => [d.channel, d.status, d.error]).sort(), [["email", "failed", "email-not-configured"], ["mybrain", "failed", "mybrain-not-configured"]]);
  }
  assert.equal((await store.feed(1)).length, 1);
  // Prisma feed: groups across channels, newest first, bounded.
  const rows = [
    { noticeId: "b", channel: "mybrain", status: "sent", error: null, kind: "info", title: "B", body: "", reasons: [], createdAt: new Date(2) },
    { noticeId: "b", channel: "email", status: "failed", error: "email-timeout", kind: "info", title: "B", body: "", reasons: [], createdAt: new Date(2) },
    { noticeId: "a", channel: "email", status: "sent", error: null, kind: "info", title: "A", body: "", reasons: [], createdAt: new Date(1) },
  ];
  const tx = { notification: { findMany: async (q) => (q.select ? rows.slice(0, q.take) : rows.filter((r) => q.where.noticeId.in.includes(r.noticeId))) } };
  const pfeed = await new PrismaNotificationStore({ $transaction: async (fn) => fn(tx) }, 1000).feed(50);
  assert.deepEqual(pfeed.map((f) => [f.id, f.deliveries.length]), [["b", 2], ["a", 1]]);
});

