// M2.2-d2 (docs/modules/M2.2.md): spec intake routes. KK uploads or pastes a spec; the M2.2-d1 pipeline stores a new
// version, drafts docs/requirements.md and raises one requirements card. The doc is approved by reconciling the
// card's decision (`syncApproval`, a POST), so this module needs no hook inside the M2.3 approvals routes.
import { Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { PipelineError, type DocRow, type RequirementsPipeline, type RequirementsStore } from "@devos/analyst";
import { httpError } from "./auth.js";
import type { DevosRequest } from "./http.js";
import { preflightView, type PreflightViewReader, type SecretPresence } from "./preflight.js";

export const REQUIREMENTS = Symbol("devos:requirements");

/** The slice of the M2.3 approval store this module reads (ApprovalStore satisfies it). */
export interface CardReader {
  get(id: string): Promise<{ id: string; gate: string; status: string; decidedAt?: Date | null } | null>;
  /** ADR-0012 CR-a2: the card's comments, oldest first (ApprovalStore.comments). */
  comments?(id: string): Promise<{ id?: string; body: string; createdAt?: Date }[]>;
}

export interface RequirementRowView {
  key: string;
  title: string;
  priority: string;
  acceptance: string;
  milestone: number | null;
}

export interface RequirementsServices {
  pipeline: RequirementsPipeline | null;
  store: (RequirementsStore & { rows?(projectId: string): Promise<RequirementRowView[]> }) | null;
  cards: CardReader | null;
  /** CR-a3 (DEVOS-199): the project vault's presence check for the pre-flight view; absent → secrets unverified. */
  vault?: SecretPresence | null;
}

/** The dashboard's project slug (apps/dashboard/lib/source.ts `isSlug`). */
const SLUG = /^[a-z0-9-]{2,40}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Same as the M2.1 ingest `maxBytes` default; larger bodies are refused while streaming. */
export const SPEC_BODY_MAX = 10 * 1024 * 1024;
const BODY_TIMEOUT_MS = 30_000;
const FILE_NAME = /^[^\u0000-\u001f\u007f/\\]{1,200}$/;

/**
 * Reads the request body (the app's JSON parser leaves other content types unread). Bounded in size and time
 * (ADR-0011 timeouts), so a slow or huge upload cannot hold the process.
 */
export function readBody(req: NodeJS.ReadableStream, max = SPEC_BODY_MAX, timeoutMs = BODY_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener("data", onData);
      if (err) {
        req.resume(); // drain the rest so the connection is not left half-read
        reject(err);
      } else resolve(value!);
    };
    const onData = (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > max) return finish(httpError(413, "spec-too-large"));
      chunks.push(b);
    };
    const timer = setTimeout(() => finish(httpError(408, "body-timeout")), timeoutMs);
    req.on("data", onData);
    req.once("end", () => finish(null, Buffer.concat(chunks)));
    req.once("error", () => finish(httpError(400, "body-unreadable")));
  });
}

function mapError(e: unknown): never {
  if (e instanceof PipelineError) throw httpError(e.status, e.code);
  if (e && typeof e === "object" && "getStatus" in e) throw e;
  // Store or worker faults: a fixed code, never the message (it may quote spec text).
  throw httpError(500, "requirements-store-error");
}

function need<T>(v: T | null, code: string): T {
  if (!v) throw httpError(503, code);
  return v;
}

/**
 * Applies the decision of the newest draft's requirements card, if it has one and it was decided. Idempotent:
 * safe to call on every read and from a periodic job.
 */
export async function syncApproval(svc: RequirementsServices, projectId: string, now: Date = new Date()): Promise<DocRow | null> {
  const store = need(svc.store, "requirements-not-configured");
  const pipeline = need(svc.pipeline, "requirements-not-configured");
  const doc = await store.latestDoc(projectId);
  if (!doc || !doc.approvalId || !svc.cards) return doc;
  if (doc.status === "approved") {
    await syncReanswers(svc, pipeline, doc.approvalId, now);
    return doc;
  }
  if (doc.status !== "draft") return doc;
  const card = await svc.cards.get(doc.approvalId);
  if (!card || (card.status !== "approved" && card.status !== "rejected")) return doc;
  // ADR-0012 CR-a2: KK's comments carry the pre-flight answers (`PF-<n>: …`). A reader without comments gives none,
  // so every item takes its default (the card is still applied). DEVOS-204: only comments made up to the decision
  // count here, whenever the sync runs; later ones are re-answers (`syncReanswers`).
  const decidedAt = card.decidedAt ? card.decidedAt.getTime() : null;
  const comments =
    card.status === "approved" && svc.cards.comments
      ? (await svc.cards.comments(card.id)).filter((c) => decidedAt === null || !c.createdAt || c.createdAt.getTime() <= decidedAt).map((c) => c.body)
      : [];
  await pipeline.applyDecision(card, comments);
  return store.latestDoc(projectId);
}

/**
 * DEVOS-204: how far behind `now` the re-answer cursor stays. A comment's time is taken before its transaction
 * commits (M2.3 `comment`, bounded by the store's 10 s timeout and wait), so one made just before `now` may not be
 * visible yet; the cursor never passes `now - REANSWER_SETTLE_MS`, so such a comment is still read on a later tick.
 */
export const REANSWER_SETTLE_MS = 30_000;

/** DEVOS-204: re-answers from KK's comments made after the approved intake card was decided (ADR-0012 rule 3). */
async function syncReanswers(svc: RequirementsServices, pipeline: RequirementsPipeline, approvalId: string, now: Date): Promise<void> {
  const cards = svc.cards!;
  if (!cards.comments) return;
  const card = await cards.get(approvalId);
  if (!card || card.gate !== "requirements" || card.status !== "approved" || !card.decidedAt) return;
  const all = await cards.comments(card.id);
  const comments: { id: string; body: string; createdAt: Date }[] = [];
  for (const c of all) if (c.id && c.createdAt) comments.push({ id: c.id, body: c.body, createdAt: c.createdAt });
  const newest = comments.reduce<number | null>((m, c) => (m === null || c.createdAt.getTime() > m ? c.createdAt.getTime() : m), null);
  // No comment after the decision: nothing to read and nothing to write (pre-review finding 2: a sync of an
  // approved doc stays read-only then).
  if (newest === null || newest <= card.decidedAt.getTime()) return;
  const seenUpTo = new Date(Math.min(newest, now.getTime() - REANSWER_SETTLE_MS));
  await pipeline.applyReanswers({ id: card.id, gate: card.gate, status: card.status, decidedAt: card.decidedAt }, comments, seenUpTo);
}

@Controller("projects")
export class RequirementsController {
  constructor(@Inject(REQUIREMENTS) private readonly svc: RequirementsServices) {}

  /**
   * New spec version. `Content-Type: text/markdown` = pasted text (UTF-8); `application/octet-stream` = a file,
   * named by the `X-Devos-Filename` header (.docx, .pdf, .md, .html; type sniffed by M2.1).
   */
  @Post(":id/spec")
  @HttpCode(201)
  async submit(@Param("id") id: string, @Req() req: DevosRequest) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const pipeline = need(this.svc.pipeline, "requirements-not-configured");
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "text/markdown" && type !== "application/octet-stream") throw httpError(415, "body-unsupported-type");
    let name: string | null = null;
    if (type === "application/octet-stream") {
      const h = req.headers["x-devos-filename"];
      if (typeof h !== "string" || !FILE_NAME.test(h)) throw httpError(400, "invalid:filename");
      name = h;
    }
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length > SPEC_BODY_MAX) throw httpError(413, "spec-too-large");
    const body = await readBody(req as unknown as NodeJS.ReadableStream);
    let input;
    if (name === null) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        throw httpError(400, "text-not-utf8");
      }
      input = { kind: "paste" as const, text };
    } else {
      input = { kind: "file" as const, bytes: new Uint8Array(body), originalName: name };
    }
    const r = await pipeline.submitSpec(id, input).catch(mapError);
    return { result: r };
  }

  /** The newest requirements doc and the stored requirement rows. Read-only (ADR-0011 §1: GET never writes). */
  @Get(":id/requirements")
  async get(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const store = need(this.svc.store, "requirements-not-configured");
    const project = await store.project(id).catch(mapError);
    if (!project) throw httpError(404, "project-not-found");
    const doc = await store.latestDoc(id).catch(mapError);
    const rows = store.rows ? await store.rows(id).catch(mapError) : [];
    return { doc, requirements: rows };
  }

  /**
   * CR-a3 (DEVOS-199): the project page's read-only pre-flight section — state, the list KK saw, missing secret
   * names ("waiting for secrets") and the decision log. GET never writes (ADR-0011 §1); no secret value is read.
   */
  @Get("by-slug/:slug/preflight")
  async preflight(@Param("slug") slug: string) {
    if (!SLUG.test(slug)) throw httpError(400, "invalid:slug");
    const store = need(this.svc.store, "requirements-not-configured") as unknown as Partial<PreflightViewReader>;
    if (typeof store.projectBySlug !== "function" || typeof store.decisions !== "function" || typeof store.preflightSnapshot !== "function") {
      throw httpError(503, "preflight-not-configured");
    }
    const view = await preflightView(slug, store as PreflightViewReader, this.svc.vault ?? null).catch(mapError);
    if (!view) throw httpError(404, "project-not-found");
    return { preflight: view };
  }

  /**
   * Applies the decided requirements card to the newest draft. State-changing, so it is a POST behind the
   * Origin and CSRF checks (PR66-r1); M2.2-d3 also runs it from a job.
   */
  @Post(":id/requirements/sync")
  @HttpCode(200)
  async sync(@Param("id") id: string) {
    if (!UUID.test(id)) throw httpError(400, "invalid:id");
    const store = need(this.svc.store, "requirements-not-configured");
    const project = await store.project(id).catch(mapError);
    if (!project) throw httpError(404, "project-not-found");
    const doc = await syncApproval(this.svc, id).catch(mapError);
    return { doc };
  }
}
