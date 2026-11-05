# ADR-0007 — Code Mode: reject Cloudflare and goose routes; spike Claude Programmatic Tool Calling

- **Status:** accepted (4 Nov 2026, KK approval; Architect under D10). Applies to M3.7 (new).
- **Context:** "Code Mode" lets a model write a program that calls tools in a sandbox so only final results enter context. Three routes were assessed: Cloudflare's Code Mode MCP server (`search()`/`execute()`, about 1,000 tokens for 2,500+ endpoints; blog 20 Feb 2026); Claude API Programmatic Tool Calling (`code_execution_20260120` or later, `allowed_callers` per tool; stable on Sonnet 5.5 and Opus 5.5); goose's `code_execution` extension.
- **Decision:**
  1. Reject Cloudflare Code Mode: O3 removed Cloudflare; the server needs a Workers project; experimental.
  2. Reject goose Code Mode: a third agent runtime against D1/D7; documented as a JavaScript context only.
  3. Spike PTC in P3 (M3.7) on one Maintainer task and one Analyst task, against direct tool calls. Adopt per role only if it passes the quality guard (ADR-0008).
- **Guards / known limits (from Claude docs):**
  - `allowed_callers` is not a security boundary; every PTC tool call still returns to DevOS and passes the PreToolUse hook and M1.7.
  - Not zero-data-retention eligible; container data is kept up to 30 days. Never use PTC on repos or data KK marks sensitive.
  - Tools from the MCP connector cannot be called from code; `strict: true` tools are not supported.
  - A pending tool result times out after about 4 minutes; idle containers are reclaimed after about 5.
  - Verify in the spike whether the Agent SDK exposes PTC, and current code-execution container pricing.
- **Consequences:** no runtime change before P3; one spike module.
- **Numbering note (4 Nov 2026):** the spike is tracked as **M3.9** (Linear DEVOS-58), because M3.7 (skill discovery, DEVOS-49) and M3.8 (reference-repo build, DEVOS-50) already existed. "M3.7" above refers to that spike.
