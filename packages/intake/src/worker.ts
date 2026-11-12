import { parentPort, workerData } from "node:worker_threads";
import { IngestError } from "./errors.js";
import { parseSpec, type IngestOptions } from "./parse.js";

interface Job {
  bytes: Uint8Array;
  name: string;
  options: IngestOptions;
}

const job = workerData as Job;
try {
  const result = parseSpec(job.bytes, job.name, job.options);
  parentPort?.postMessage({ ok: true, result });
} catch (err) {
  // Only fixed codes cross back; never a message from the parser.
  parentPort?.postMessage({ ok: false, code: err instanceof IngestError ? err.code : "parse-failed" });
}
