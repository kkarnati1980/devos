// M2.2-d2 (docs/modules/M2.2.md): spec intake routes. KK uploads or pastes a spec; the M2.2-d1 pipeline stores a new
// version, drafts docs/requirements.md and raises one requirements card. The doc is approved by reconciling the
// card's decision (`syncApproval`, a POST), so this module needs no hook inside the M2.3 approvals routes.
import { Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { PipelineError, type DocRow, type RequirementsPipeline, type RequirementsStore } from "@devos/analyst";
import { httpError } from "./auth.js";
import type { DevosRequest } from "./http.js";

export const REQUIREMENTS = Symbol("devos:requirements");

/** The slice of the M2.3 approval store this module reads (ApprovalStore satisfies it). */
export interface CardReader {
  get(id: string): Promise<{ id: string; gate: string; status: string } | null>;
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
}

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
export async function syncApproval(svc: RequirementsServices, projectId: string): Promise<DocRow | null> {
  const store = need(svc.store, "requirements-not-configured");
  const pipeline = need(svc.pipeline, "requirements-not-configured");
  const doc = await store.latestDoc(projectId);
  if (!doc || doc.status !== "draft" || !doc.approvalId || !svc.cards) return doc;
  const card = await svc.cards.get(doc.approvalId);
  if (!card || card.status !== "approved") return doc;
  await pipeline.applyDecision(card);
  return store.latestDoc(projectId);
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
