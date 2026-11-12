// JSON log lines with a request ID (SM-09 Lite starts here). Never log headers or bodies wholesale.
import crypto from "node:crypto";
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
export const requestId = (incoming) => (typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID());
export function log(fields, out = process.stdout) {
  out.write(JSON.stringify({ time: new Date().toISOString(), ...fields }) + "\n");
}
