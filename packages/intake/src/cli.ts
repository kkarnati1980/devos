#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { DEFAULT_LIMITS } from "./limits.js";
import { IngestError } from "./errors.js";
import { ingest } from "./ingest.js";

/** G2 evidence tool: `node dist/cli.js <spec file>` prints the format, block counts, warnings and requirement IDs. */
async function main(): Promise<number> {
  const file = process.argv.slice(2).find((a) => a !== "--");
  if (!file) {
    process.stderr.write("usage: check-spec <file>\n");
    return 64;
  }
  if (statSync(file).size > DEFAULT_LIMITS.maxBytes) {
    process.stdout.write("refused: too-large\n");
    return 2;
  }
  try {
    const r = await ingest(readFileSync(file), file);
    const counts: Record<string, number> = {};
    for (const b of r.blocks) counts[b.type] = (counts[b.type] ?? 0) + 1;
    const fr = r.requirementIds.filter((x) => /^FR-?\d/.test(x.id));
    process.stdout.write(
      [
        `format: ${r.format}`,
        `sha256: ${r.sha256}`,
        `blocks: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
        `warnings: ${r.warnings.join(" ") || "none"}`,
        `requirement-ids: ${r.requirementIds.length} unique (FR: ${fr.length})`,
        ...r.requirementIds.map((x) => `  ${x.id} ×${x.count}`),
        "",
      ].join("\n"),
    );
    return 0;
  } catch (err) {
    process.stdout.write(`refused: ${err instanceof IngestError ? err.code : "parse-failed"}\n`);
    return 2;
  }
}

main().then((code) => process.exit(code));
