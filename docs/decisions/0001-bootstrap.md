# ADR-0001 — Bootstrap

- **Status:** accepted (29 Oct 2026)
- **Context:** DevOS build begins. Authoritative decisions are in the DevOS Decision Record v1.3.0 (D1–D13, O1–O10) in the claude.ai project "AI Development Team".
- **Decision:** This repo is the monorepo for the DevOS build (apps/dashboard, apps/api, packages/shared). Linear team **Devos** / project **AI Development Team** is the plan; GitHub holds code; PRs link to Linear issues by branch name; no issue mirroring. `rules.md` → `CLAUDE.md` + `AGENTS.md` via `pnpm gen:rules`.
- **Consequences:** Phase-0 modules (M0.1–M0.6) start from here. Technical defaults (deploy probation, archive window, monitoring stack) are Architect decisions logged as further ADRs in this folder.
