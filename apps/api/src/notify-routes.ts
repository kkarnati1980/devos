// M1.6 routes (docs/modules/M1.6.md). All `session` (deny by default); writes pass M1.2's CSRF checks.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { httpError } from "./auth.js";
import { NOTIFY, NoticeError, parseChannelPatch, type Notifier } from "./notify.js";

export interface NotifyServices {
  notifier: Notifier | null;
}

const FEED_LIMIT = 50;

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && "getStatus" in e) throw e;
    if (e instanceof NoticeError) throw httpError(400, e.code);
    // A store or driver message is never returned or logged.
    throw httpError(503, "notifications-store-error");
  }
}

@Controller("notifications")
export class NotificationsController {
  constructor(@Inject(NOTIFY) private readonly svc: NotifyServices) {}

  private notifier(): Notifier {
    if (!this.svc.notifier) throw httpError(503, "notifications-not-configured");
    return this.svc.notifier;
  }

  /** The dashboard feed: newest 50 notices with each channel's delivery status. */
  @Get()
  async feed() {
    const n = this.notifier();
    return { notices: await guarded(() => n.store.feed(FEED_LIMIT)) };
  }

  @Get("channels")
  async channels() {
    const n = this.notifier();
    const [list, configured] = await guarded(() => Promise.all([n.store.channels(), n.configured()]));
    return {
      channels: list.map((c) => ({ ...c, configured: c.kind === "dashboard" ? true : configured[c.kind] })),
    };
  }

  /** Enable or disable a channel, or set its target (bell URL / recipient address). Audited. */
  @Put("channels/:kind")
  @HttpCode(200)
  async setChannel(@Param("kind") kind: string, @Body() body: unknown) {
    const n = this.notifier();
    const p = parseChannelPatch(kind, body, n.cfg.allowLoopbackHttp);
    if (typeof p === "string") throw httpError(400, p);
    const audit = {
      action: "notification.channel.updated",
      summary: `Notification channel ${p.kind} saved`,
      details: { channel: p.kind, fields: Object.keys(p.patch) },
    };
    return { channel: await guarded(() => n.store.setChannel(p.kind, p.patch, audit)) };
  }

  /** "Done when": one test card reaches every enabled channel. Returns each channel's outcome. */
  @Post("test")
  @HttpCode(201)
  async test() {
    const n = this.notifier();
    return guarded(() =>
      n.notify({
        kind: "test",
        title: "DevOS test card",
        body: "This is a test notice from DevOS. If you can read it here, this channel works.",
        reasons: ["Sent from the dashboard notifications page"],
        projectId: null,
        approvalId: null,
      }),
    );
  }
}
