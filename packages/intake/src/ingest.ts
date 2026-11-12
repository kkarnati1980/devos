import { Worker } from "node:worker_threads";
import { IngestError, isIngestErrorCode } from "./errors.js";
import { resolveLimits } from "./limits.js";
import { precheck, type IngestOptions, type IngestResult } from "./parse.js";

/**
 * Ingest an uploaded spec. Size and type are checked here; parsing runs in a worker with its own heap cap and a
 * wall-clock limit, so a hostile file cannot exhaust or stall the API process.
 */
export async function ingest(bytes: Uint8Array, originalName: string, options: IngestOptions = {}): Promise<IngestResult> {
  const limits = resolveLimits(options.limits);
  precheck(bytes, originalName, limits);
  const copy = new Uint8Array(bytes); // the worker gets its own copy
  return await new Promise<IngestResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { bytes: copy, name: originalName, options },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.workerHeapMb,
        maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.floor(limits.workerHeapMb / 8))),
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new IngestError("parse-timeout"))), limits.parseTimeoutMs);
    worker.on("message", (msg: { ok: boolean; result?: IngestResult; code?: unknown }) => {
      if (msg.ok && msg.result) finish(() => resolve(msg.result as IngestResult));
      else finish(() => reject(new IngestError(isIngestErrorCode(msg.code) ? msg.code : "parse-failed")));
    });
    worker.on("error", (err: Error & { code?: string }) => {
      finish(() => reject(new IngestError(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "parse-memory" : "parse-failed")));
    });
    worker.on("exit", () => finish(() => reject(new IngestError("parse-failed"))));
  });
}
