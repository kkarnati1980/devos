# ADR-0002 — Server sizing & Codex review mechanism

- **Status:** accepted (30 Oct 2026)
- **Context:** Decision Record v1.3.0 set O1 = Hostinger KVM 8 and H6 = Codex GitHub app. On review for personal use (pilot deferred), both are revisited.

## Decisions

1. **Server: Hostinger KVM 4** (4 vCPU / 16 GB / 200 GB NVMe), India DC, "Ubuntu 24.04 with Coolify" template — **supersedes O1's KVM 8**. 16 GB comfortably covers Coolify + Postgres + Redis + dashboard/API + 2 parallel build lanes (incl. Playwright/Chromium) + a few project stacks for personal-scale use. Hostinger allows in-place upgrade to KVM 8 if concurrency grows. MyBrain stays on KVM 1 (srv1834343); Postiz on KVM 2 is untouched.

2. **Codex review = CLI, API-key-authenticated** (`codex exec review` with a JSON output schema), running in the read-only sandbox on the server, authenticated by `OPENAI_API_KEY` (the $15-capped key). It emits the structured PASS / CHANGES_REQUESTED verdict stored per commit SHA that gates merges (D1) and closes G3. **The Codex GitHub app (H6) is deferred/optional** — it would require a paid ChatGPT plan and only adds in-PR UI comments; it can be added later without rework. This clarifies D1's implementation; it does not change D1.

## Consequences
- Phase-0 spec updated to KVM 4; H6 marked optional.
- First-agent-run blockers unchanged: H3 (GitHub token), H4 (Anthropic key), H5 (OpenAI key).
- Decision Record to be bumped v1.3.0 → v1.3.1 (O1 amended, Codex mechanism clarified).
