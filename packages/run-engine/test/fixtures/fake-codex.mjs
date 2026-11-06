#!/usr/bin/env node
// Fake `codex exec --json -` for M1.5 tests. Behaviour is chosen by FAKE_CODEX_MODE.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
if (process.env.FAKE_CODEX_ARGVFILE) writeFileSync(process.env.FAKE_CODEX_ARGVFILE, JSON.stringify(process.argv.slice(2)));
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "thread.started", thread_id: "t-1" });
  if (mode === "orphan") {
    // The parent exits on SIGTERM; a grandchild that ignores SIGTERM and holds none of our stdio stays.
    const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_CODEX_PIDFILE) writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(g.pid));
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "hang") {
    // A grandchild in the same process group: cancel must kill it too.
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_CODEX_PIDFILE) writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(g.pid));
    process.on("SIGTERM", () => {}); // ignore TERM: the adapter must escalate to KILL
    setInterval(() => {}, 1000);
    return;
  }
  for (let t = 1; t <= 2; t++) {
    out({ type: "turn.started" });
    out({ type: "item.started", item: { id: `c${t}`, type: "command_execution", command: "ls" } });
    out({ type: "item.completed", item: { id: `c${t}`, type: "command_execution", aggregated_output: "x".repeat(100 * t), exit_code: 0 } });
    if (mode !== "nousage") out({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50 } });
    else out({ type: "turn.completed" });
  }
  out({ type: "item.completed", item: { id: "m", type: "agent_message", text: `VERDICT: PASS (${prompt.length})` } });
  if (mode === "fail") {
    out({ type: "turn.failed", error: { message: "boom" } });
    process.exit(1);
  }
  process.exit(0);
});
