// Generates CLAUDE.md and AGENTS.md from rules.md so the two rulebooks never drift.
// Usage: node scripts/gen-rules.mjs          (write)
//        node scripts/gen-rules.mjs --check  (fail if out of date; used in CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const body = readFileSync(new URL('rules.md', root), 'utf8');
const banner = '<!-- GENERATED from rules.md by `pnpm gen:rules`. Edit rules.md, not this file. -->\n\n';
const codexTail =
  '\n\n## Codex review\n' +
  'Review the diff against these rules and the module contract. Return `PASS` or `CHANGES_REQUESTED` ' +
  'using the JSON verdict schema in `packages/shared`. Do not edit code; auto-fix is off.\n';

const targets = [
  { file: 'CLAUDE.md', content: banner + body },
  { file: 'AGENTS.md', content: banner + body + codexTail },
];

const check = process.argv.includes('--check');
let drift = false;
for (const t of targets) {
  const path = new URL(t.file, root);
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch {}
    if (current !== t.content) { drift = true; console.error(`${t.file} is out of date — run \`pnpm gen:rules\`.`); }
  } else {
    writeFileSync(path, t.content);
    console.log(`Wrote ${t.file} from rules.md (${fileURLToPath(path)})`);
  }
}
if (check && drift) process.exit(1);
if (check) console.log('CLAUDE.md and AGENTS.md are in sync with rules.md.');
