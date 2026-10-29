# Phase 0 — Server & Environment Setup

Status: spec for KK to action. Derived from Decision Record v1.3.0 (O1–O7, O10) and PRD v1.3.0. Nothing here touches MyBrain.

This is the checklist that must be done **before** the DevOS build agents can run end-to-end. It separates **what KK does by hand** (accounts, money, secrets) from **what DevOS/Claude does in code** (provisioning, config, wiring). Secrets are entered directly into the server's secret store or the provider console — **never pasted into chat or committed**.

---

## A. What KK provisions by hand (Linear human tasks H1–H9)

| # | Task | Detail | Needed for |
|---|------|--------|-----------|
| H1 | Buy the DevOS server | Hostinger **KVM 8** (8 vCPU / 32 GB / 400 GB NVMe), India DC, template **"Ubuntu 24.04 with Coolify"**. Dedicated to DevOS; MyBrain stays on srv1834343 (KVM 1), untouched. | O1 |
| H2 | Cloudflare Zero Trust | Enable Access + Tunnel on `accelr8.in`; Google as the identity provider; one Access application for `devos.accelr8.in` (policy: allow KK's Google account). | O3, O4 |
| H3 | GitHub token | Fine-grained PAT, **All repositories**, 1-year expiry, permissions: Administration (incl. repo creation), Contents, Issues, Pull requests, Workflows, Actions, Commit statuses, Webhooks, Secrets, Environments, Metadata (RW where applicable). Store in DevOS secret store as `GITHUB_TOKEN`. | O7, O10 |
| H4 | Codex GitHub App | Install OpenAI Codex app on the `kkarnati1980` account, **review on, auto-fix off**, scope All repositories. | D1 |
| H5 | Anthropic API key | New key, provider-side monthly cap **USD 15** (editable). Store as `ANTHROPIC_API_KEY`. | O5 |
| H6 | OpenAI API key | New key (for Codex), provider-side monthly cap **USD 15**. Store as `OPENAI_API_KEY`. | O5 |
| H7 | Cloudflare R2 bucket | One bucket for off-server Postgres backups; R2 token with object RW. Store creds as `R2_*`. | O2 |
| H8 | Linear API key | Personal API key for the orchestrator to read/write issues. Store as `LINEAR_API_KEY`. | D10 |
| H9 | Domain DNS | Confirm `accelr8.in` is on Cloudflare; DevOS subdomains created by Tunnel config (no manual A records). | O3 |

KK also confirms, in Phase 0, the technical defaults so they can be logged as ADRs: 15-minute deploy probation, 30-day archive window, NFR targets, Uptime Kuma + Sentry monitoring, R2 backup retention.

---

## B. What DevOS/Claude does in code (Phase-0 modules M0.1–M0.6)

These run on KK's existing setup (this environment + the new server) under the normal build loop. DevOS never deploys changes to itself without KK's approval.

| Module | Output |
|--------|--------|
| M0.1 | Repo + monorepo scaffold (**this repo** — done), `rules.md` → `CLAUDE.md`/`AGENTS.md`, CI (install/typecheck/lint/test + rules-drift), branch protection on `main`. |
| M0.2 | Coolify bootstrap: DevOS stack definition (Docker Compose), Postgres service, Redis service, per-project preview+live stack template. |
| M0.3 | Cloudflare Tunnel + Access config as code; `devos.accelr8.in` routed to the dashboard; per-project subdomain pattern. |
| M0.4 | Secret store on the server (what the agents read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `LINEAR_API_KEY`, `R2_*` from); env schema + validation. |
| M0.5 | Postgres backup job → R2, nightly, with weekly automated test-restore. |
| M0.6 | Agent runner base image: Node 22, pnpm, Claude Code / Agent SDK, Codex CLI, git, the sandbox the RE/skills/repo-read capabilities (D11–D13) run inside. |

**Gate G0 (closes Phase 0):** stored evidence that — CI is green on `main`; branch protection blocks direct pushes; the server resolves `devos.accelr8.in` behind Access (Google login enforced, no public exposure); Postgres backup to R2 ran and a test-restore succeeded; the agent runner image builds and can execute one trivial Claude + Codex round trip reading secrets from the store.

---

## C. What this environment (where we are now) already covers

- **This repo** is scaffolded and pushed (M0.1 in progress).
- **Linear**: team Devos / project "AI Development Team", milestones per phase, module issues, labels, One-way GitHub→Linear sync, PR/branch linking (O10) — configured.
- **GitHub**: `devos` repo created (private, under `kkarnati1980`); Claude GitHub App scoped to All repositories.

---

## D. Order of operations

1. KK completes H1–H9 (server, Cloudflare, tokens, keys, R2) and enters secrets into the provider consoles / server store.
2. DevOS runs M0.2–M0.6 against the new server.
3. Gate G0 evidence captured → Phase 0 closes.
4. Phase 1 (orchestrator + dashboard skeleton) begins.

KK's blocking items for the **first** agent run are **H3 (GitHub token), H5 (Anthropic key), H6 (OpenAI key), H8 (Linear key)**. H1/H2/H7 are needed before M0.2 (server-side modules) but not before the repo/CI work.
