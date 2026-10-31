// M0.6 AT: rules.md is the single source; `gen:rules --check` passes in sync and fails on drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'devos-rules-'));
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(root, 'scripts/gen-rules.mjs'), path.join(dir, 'scripts/gen-rules.mjs'));
  for (const f of ['rules.md', 'CLAUDE.md', 'AGENTS.md']) cpSync(path.join(root, f), path.join(dir, f));
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/gen-rules.mjs'), ...args], { encoding: 'utf8' });

test('committed CLAUDE.md and AGENTS.md are in sync with rules.md', () => {
  const dir = sandbox();
  try { assert.equal(run(dir, '--check').status, 0); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--check fails when a generated file is edited by hand', () => {
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const dir = sandbox();
    try {
      writeFileSync(path.join(dir, f), readFileSync(path.join(dir, f), 'utf8') + '\nhand edit\n');
      const r = run(dir, '--check');
      assert.equal(r.status, 1, `${f} drift not detected`);
      assert.match(r.stderr, new RegExp(`${f} is out of date`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('--check fails when rules.md changes without regenerating; gen:rules fixes it', () => {
  const dir = sandbox();
  try {
    writeFileSync(path.join(dir, 'rules.md'), readFileSync(path.join(dir, 'rules.md'), 'utf8') + '\n- new rule\n');
    assert.equal(run(dir, '--check').status, 1);
    assert.equal(run(dir).status, 0);
    assert.equal(run(dir, '--check').status, 0);
    assert.ok(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes('- new rule'));
    assert.ok(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('- new rule'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generated files carry the do-not-edit banner; AGENTS.md adds the Codex section', () => {
  const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(claude, /^<!-- GENERATED from rules\.md/);
  assert.match(agents, /^<!-- GENERATED from rules\.md/);
  assert.match(agents, /## Codex review/);
});
