// Shared fixtures for the M1.5 Postgres/Redis tests. Rows are committed (run_event is append-only),
// so every test makes its own project.
import { randomBytes } from "node:crypto";

export async function runFixture(db, { maxCostUsd = "5", maxTurns = 50, maxSeconds = 600, model = "claude-sonnet" } = {}) {
  const slug = `m15-${randomBytes(6).toString("hex")}`;
  const project = await db.project.create({ data: { slug, name: slug } });
  const ms = await db.milestone.create({ data: { projectId: project.id, ordinal: 1, name: "P1", gateName: "G1" } });
  const mod = await db.module.create({ data: { projectId: project.id, milestoneId: ms.id, key: "M1.5", title: "Run engine", lane: 1, contractPath: "docs/modules/M1.5.md" } });
  const task = await db.task.create({ data: { projectId: project.id, moduleId: mod.id, kind: "build", title: "Build" } });
  const run = await db.run.create({ data: { taskId: task.id, projectId: project.id, role: "builder", model, maxTurns, maxSeconds, maxCostUsd } });
  return { projectId: project.id, runId: run.id };
}

/** A fake Agent SDK `query` (same shape as the unit tests). */
export function fakeQuery({ turns = 2, cost = 0.12, calls = [] } = {}) {
  return ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: options.resume ?? "sess-db" };
      for (let t = 1; t <= turns; t++) {
        yield { type: "assistant", message: { model: "claude-sonnet", content: [{ type: "tool_use", id: `u${t}`, name: "Read", input: {} }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 10 } } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `u${t}`, content: "y".repeat(64) }] } };
      }
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "done" };
    })();
  };
}
