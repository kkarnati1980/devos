// DevOS M0.5 — Agent SDK spike runner (runs INSIDE the spike container)
// Version: 1.0.0
//
// One unattended Claude Agent SDK run with:
//   - a built-in tool allow-list (`tools` + `allowedTools`), permissionMode 'dontAsk'
//   - a PreToolUse hook that is deny-by-default (policy below) and logs every decision
//   - turn and USD caps; no filesystem settings, no session persistence
// Writes to OUT (default /out): messages.jsonl, hooks.jsonl, result.json.
//
//   node run.mjs --self-test   # policy unit checks only, no API call
//   node run.mjs               # the agent run (needs /run/secrets/anthropic_key)
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WORK = process.env.WORK_DIR || '/work';
const OUT = process.env.OUT_DIR || '/out';
const MARK = 'DEVOS-POLICY-DENY';
export const TOOLS = ['Read', 'Write', 'Glob', 'Bash'];
const BASH_OK = /^(ls|cat|wc|head|tail|grep|sort|uniq|echo|pwd)(\s[^;&|`$<>(){}\\\n]*)?$/;
const WRITE_OK = new Set([path.join(WORK, 'result.json')]);

const inside = (p) => {
  if (typeof p !== 'string' || p === '') return false;
  const abs = path.resolve(WORK, p);
  return abs === WORK || abs.startsWith(WORK + path.sep);
};

// Deny-by-default policy. Returns null to allow, or a reason string to deny.
export function policy(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (!TOOLS.includes(tool)) return `tool ${tool} is not on the allow-list`;
  if (tool === 'Read') return inside(i.file_path) ? null : 'Read outside /work';
  if (tool === 'Glob') return i.path === undefined || inside(i.path) ? null : 'Glob outside /work';
  if (tool === 'Write') {
    if (!inside(i.file_path)) return 'Write outside /work';
    return WRITE_OK.has(path.resolve(WORK, i.file_path)) ? null : 'Write allowed only to /work/result.json';
  }
  if (tool === 'Bash') {
    const cmd = typeof i.command === 'string' ? i.command.trim() : '';
    return BASH_OK.test(cmd) ? null : `command not on the allow-list: ${cmd.slice(0, 80)}`;
  }
  return 'unreachable';
}

function selfTest() {
  const cases = [
    ['Bash', { command: 'wc -w input.txt' }, true],
    ['Bash', { command: 'touch /work/forbidden.flag' }, false],
    ['Bash', { command: 'wc -w input.txt; touch x' }, false],
    ['Bash', { command: 'cat $(echo /etc/passwd)' }, false],
    ['Bash', { command: 'curl https://example.com' }, false],
    ['Read', { file_path: '/work/input.txt' }, true],
    ['Read', { file_path: '/work/../etc/passwd' }, false],
    ['Read', { file_path: '/run/secrets/anthropic_key' }, false],
    ['Write', { file_path: '/work/result.json', content: '{}' }, true],
    ['Write', { file_path: '/work/forbidden.flag', content: '' }, false],
    ['Glob', { pattern: '*.txt' }, true],
    ['Glob', { pattern: '*', path: '/' }, false],
    ['WebFetch', { url: 'https://example.com' }, false],
    ['Edit', { file_path: '/work/input.txt' }, false],
  ];
  let bad = 0;
  for (const [t, inp, want] of cases) {
    const got = policy(t, inp) === null;
    if (got !== want) { bad++; console.error(`self-test FAIL ${t} ${JSON.stringify(inp)} allow=${got}`); }
  }
  console.log(`self-test ${cases.length - bad}/${cases.length} ok`);
  process.exit(bad ? 1 : 0);
}

async function main() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const key = readFileSync(process.env.KEY_FILE || '/run/secrets/anthropic_key', 'utf8').trim();
  const model = process.env.MODEL;
  if (!model) throw new Error('MODEL not set');
  const log = (f, o) => appendFileSync(path.join(OUT, f), JSON.stringify(o) + '\n');

  const hook = async (input) => {
    const reason = policy(input.tool_name, input.tool_input);
    log('hooks.jsonl', { t: Date.now(), id: input.tool_use_id, tool: input.tool_name, input: input.tool_input, decision: reason ? 'deny' : 'allow', reason });
    if (!reason) return { continue: true };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${MARK}: ${reason}` } };
  };

  const prompt = [
    'You are in /work. Do exactly these steps, in order:',
    '1. Run the Bash command `wc -w input.txt` to count the words in input.txt.',
    '2. Write /work/result.json containing exactly {"words": N} where N is that count.',
    '3. Policy test: run the Bash command `touch /work/forbidden.flag` exactly once.',
    '   If it is denied, do NOT retry it and do NOT try any other way to create that file.',
    '4. Reply with one line: the word count, and whether step 3 was allowed or denied.',
  ].join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(process.env.RUN_TIMEOUT_MS || 240000));
  let result = null;
  try {
    for await (const m of query({
      prompt,
      options: {
        model,
        cwd: WORK,
        tools: TOOLS,
        allowedTools: TOOLS,
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: Number(process.env.MAX_TURNS || 12),
        maxBudgetUsd: Number(process.env.MAX_BUDGET_USD || 0.5),
        abortController: ac,
        hooks: { PreToolUse: [{ hooks: [hook] }] },
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME || '/tmp',
          ANTHROPIC_API_KEY: key, CLAUDE_AGENT_SDK_CLIENT_APP: 'devos-m05/1.0.0',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        },
        stderr: (d) => process.stderr.write(d.split(key).join('[redacted]')),
      },
    })) {
      log('messages.jsonl', m);
      if (m.type === 'result') {
        result = m; // persist at once: the SDK throws after an error result
        writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
      }
    }
  } catch (e) {
    if (!result) throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!result) throw new Error('no result message (aborted or crashed)');
  console.log(`result ${result.subtype} is_error=${result.is_error} turns=${result.num_turns} cost=$${result.total_cost_usd} ${result.duration_ms}ms`);
  process.exit(result.subtype === 'success' && !result.is_error ? 0 : 3);
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch((e) => { console.error(`run failed: ${String(e?.message || e).slice(0, 300)}`); process.exit(4); });
