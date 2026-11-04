# ADR-0009 — One internal run contract for Claude and Codex runs (ideas from UHP)

- **Status:** accepted (4 Nov 2026, KK approval; Architect under D10). Applies to M1.1, M1.5, M3.4, M3.6.
- **Context:** The Unified Harness Protocol (UHP 2026-09-12) and its server HarnessRouter (Apache-2.0) standardise task creation, progress, sessions, files, cancellation and errors across agent runtimes. DevOS runs exactly two runtimes with fixed roles (D1): Claude Agent SDK (build) and Codex CLI (review). HarnessRouter is not adopted (ADR-0006 rationale, D7); its contract ideas are.
- **Decision:**
  1. One `RunAdapter` interface in M1.5 with two implementations: `ClaudeAgentSdkAdapter` and `CodexExecAdapter`. Methods: `start(task, envelope)`, `events()`, `cancel(runId)`, `result()`.
  2. **Typed, numbered events:** `{runId, seq, ts, type, payload}`; `type ∈ {status, text, tool_call, tool_result, artifact, usage, error, done}`. `seq` is gapless per run, so consumers process in order and detect loss.
  3. **Typed errors:** `provider_error, rate_limited, policy_denied, budget_exceeded, timeout, cancelled, missing_input, sandbox_error, internal`. `policy_denied` and `budget_exceeded` never count as failed attempts (ADR-0006).
  4. **Defined cancellation** per adapter: the SDK abort controller for Claude; process-group kill for Codex. A cancelled run checkpoints first where possible.
  5. **Handoff, not resume,** across runtimes and escalation steps: the next run receives the task, the failed diffs, exact errors and artifacts, never another runtime's session. This is the D6 escalation rule made explicit.
- **Consequences:** the dashboard, cost meter, policy engine and router consume one event stream; adding a runtime later means one adapter, not a rewrite.
