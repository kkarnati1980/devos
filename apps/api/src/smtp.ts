// M1.6 email sender: a minimal SMTP client (node:net / node:tls, no dependency). It sends one
// plain-text message to one recipient. TLS is required (implicit TLS or STARTTLS); plaintext SMTP is
// allowed only to a loopback relay. Every failure is a fixed code; a server reply is never returned,
// stored or logged. The whole exchange has one deadline (ADR-0011 §9) and is never retried.
import net from "node:net";
import tls from "node:tls";

export type SmtpSecurity = "tls" | "starttls" | "plain";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  /** Not from the environment: read from the vault (`smtp_password`) at send time. */
  pass: string | null;
  from: string;
  /** Test-only trust anchors; never set from the environment. */
  ca?: string | Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$|^::1$/;

/**
 * Reads `DEVOS_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_FROM` (none secret; the password is the
 * vault secret `smtp_password`). Without `DEVOS_SMTP_HOST` email is off (`email-not-configured`). A bad value
 * stops start-up with a code and never the value.
 */
export function parseSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = env.DEVOS_SMTP_HOST;
  if (!host) return null;
  if (!HOST.test(host)) throw new Error("config-smtp-host-invalid");
  const security = (env.DEVOS_SMTP_SECURITY ?? "tls") as SmtpSecurity;
  if (!["tls", "starttls", "plain"].includes(security)) throw new Error("config-smtp-security-invalid");
  if (security === "plain" && !LOOPBACK.has(host)) throw new Error("config-smtp-plain-not-loopback");
  const port = env.DEVOS_SMTP_PORT === undefined ? (security === "tls" ? 465 : 587) : Number(env.DEVOS_SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("config-smtp-port-invalid");
  const from = env.DEVOS_SMTP_FROM;
  if (!from || !ADDRESS.test(from)) throw new Error("config-smtp-from-invalid");
  const user = env.DEVOS_SMTP_USER || null;
  if (user && (user.length > 254 || /[\x00-\x1f\x7f]/.test(user))) throw new Error("config-smtp-user-invalid");
  return { host, port, security, user, pass: null, from };
}

/** RFC 2047 encoded-word for a header that may contain non-ASCII; CR/LF are removed first. */
export function encodeHeader(s: string): string {
  const one = s.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(one) ? one : `=?UTF-8?B?${Buffer.from(one, "utf8").toString("base64")}?=`;
}

export function buildMessage(cfg: SmtpConfig, m: MailMessage, date: Date): string {
  const domain = cfg.from.split("@")[1];
  const body = Buffer.from(m.text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: DevOS <${cfg.from}>`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${m.messageId}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}

const MAX_REPLY = 64 * 1024;
const MAX_REPLY_LINES = 100;
const MAX_CONVERSATION = 256 * 1024;

/** Line-oriented SMTP reply reader over a socket that can be swapped for its TLS upgrade. */
class Conversation {
  private buf = "";
  private waiters: Array<(r: { code: number; ext: string[] } | Error) => void> = [];
  private lines: string[] = [];
  private failed: Error | null = null;
  private total = 0;
  private replyBytes = 0;

  constructor(public sock: net.Socket) {
    this.attach(sock);
  }

  attach(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("error", () => this.fail(new Error("email-network")));
    sock.on("close", () => this.fail(new Error("email-closed")));
  }

  detach() {
    this.sock.removeAllListeners("data");
    this.sock.removeAllListeners("error");
    this.sock.removeAllListeners("close");
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    for (const w of this.waiters.splice(0)) w(e);
  }

  private onData(d: string) {
    if (this.failed) return;
    // F3 (PR18-r3): the whole conversation, one reply (continuation lines included) and its line
    // count are all bounded, not only the unparsed buffer; a peer cannot grow memory until the deadline.
    this.total += d.length;
    if (this.total > MAX_CONVERSATION) return this.fail(new Error("email-protocol"));
    this.buf += d;
    if (this.buf.length > MAX_REPLY) return this.fail(new Error("email-protocol"));
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      this.replyBytes += line.length;
      if (this.replyBytes > MAX_REPLY || this.lines.length > MAX_REPLY_LINES) return this.fail(new Error("email-protocol"));
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        this.replyBytes = 0;
        const done = this.lines.splice(0);
        const w = this.waiters.shift();
        if (w) w({ code: Number(line.slice(0, 3)), ext: done.map((l) => l.slice(4)) });
      } else if (!/^\d{3}-/.test(line)) return this.fail(new Error("email-protocol"));
    }
  }

  reply(): Promise<{ code: number; ext: string[] }> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => this.waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r))));
  }

  async cmd(line: string | null, expect: number[], code: string) {
    if (line !== null) this.sock.write(line + "\r\n");
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(code);
    return r;
  }
}

/**
 * Sends one message. Resolves `null` when the server accepted it, or a fixed error code. Never throws.
 */
export async function sendMail(cfg: SmtpConfig, m: MailMessage, timeoutMs: number, now: () => Date = () => new Date()): Promise<string | null> {
  if (!ADDRESS.test(m.to)) return "email-no-target";
  if (cfg.user && !cfg.pass) return "email-not-configured";
  let sock: net.Socket | null = null;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("email-timeout"), timeoutMs);
  });
  const run = async (): Promise<string | null> => {
    const tlsOpts = { host: cfg.host, servername: net.isIP(cfg.host) ? undefined : cfg.host, ca: cfg.ca, minVersion: "TLSv1.2" as const };
    sock = cfg.security === "tls" ? tls.connect({ ...tlsOpts, port: cfg.port }) : net.connect({ host: cfg.host, port: cfg.port });
    const c = new Conversation(sock);
    await c.cmd(null, [220], "email-greeting");
    const helo = `EHLO devos.local`;
    let ehlo = await c.cmd(helo, [250], "email-ehlo");
    if (cfg.security === "starttls") {
      if (!ehlo.ext.some((e) => /^STARTTLS\b/i.test(e))) throw new Error("email-starttls-unavailable");
      await c.cmd("STARTTLS", [220], "email-starttls");
      c.detach();
      const upgraded = tls.connect({ ...tlsOpts, socket: c.sock });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", resolve);
        upgraded.once("error", () => reject(new Error("email-tls")));
      });
      sock = upgraded;
      c.attach(upgraded);
      ehlo = await c.cmd(helo, [250], "email-ehlo");
    }
    if (cfg.user && cfg.pass) {
      const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64");
      await c.cmd(`AUTH PLAIN ${plain}`, [235], "email-auth");
    }
    await c.cmd(`MAIL FROM:<${cfg.from}>`, [250], "email-from-refused");
    await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], "email-recipient-refused");
    await c.cmd("DATA", [354], "email-data");
    const msg = buildMessage(cfg, m, now());
    await c.cmd(msg + "\r\n.", [250], "email-rejected");
    c.sock.write("QUIT\r\n");
    return null;
  };
  try {
    return await Promise.race([
      run().catch((e: unknown) => {
        const code = e instanceof Error && /^email-[a-z-]+$/.test(e.message) ? e.message : "email-error";
        return code;
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    (sock as net.Socket | null)?.destroy();
  }
}
