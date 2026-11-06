// M1.3 lint: no raw-HTML sinks and no inline styles in dashboard source
// (ADR-0011 §2; the strict CSP would block inline styles anyway).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SINKS = [
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
  [/\.(inner|outer)HTML\b/, "innerHTML/outerHTML"],
  [/insertAdjacentHTML/, "insertAdjacentHTML"],
  [/document\.write/, "document.write"],
  [/\beval\s*\(/, "eval"],
  [/new\s+Function\s*\(/, "new Function"],
  [/createContextualFragment/, "createContextualFragment"],
  [/\bsrcDoc\b|\bsrcdoc\b/, "srcdoc"],
  [/\sstyle=\{/, "inline style prop"],
  [/<script\b/, "inline <script>"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "test" || name === "scripts") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|jsx?)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".d.mts")) out.push(p);
  }
  return out;
}

export function findSinks(files = walk(root)) {
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const [re, what] of SINKS) if (re.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${what}`);
    });
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = findSinks();
  if (hits.length) {
    console.error("raw-HTML sink or inline style found:\n" + hits.join("\n"));
    process.exit(1);
  }
  console.log("no-raw-html: ok");
}
