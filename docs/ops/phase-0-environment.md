# Phase 0 — Server & Environment Setup

Status: spec for KK to action. Module/human-task numbering matches Linear project **AI Development Team** (team Devos) and Decision Record v1.3.0. Nothing here touches MyBrain.

This is the checklist that must be done **before** the DevOS build agents can run end-to-end. It separates **what KK does by hand** (accounts, money, secrets — Linear issues H1–H9) from **what DevOS/Claude does in code** (the P0 spike/scaffold modules M0.1–M0.6). Secrets are entered directly into the server's secret store or the provider console — **never pasted into chat or committed**.

---

## A. What KK provisions by hand (Linear human tasks H1–H9)

| # | Task | Detail | Unblocks |
|---|------|--------|----------|
| H1 | Buy the DevOS server ✓ | Hostinger **KVM 4** (4 vCPU / 16 GB / 200 GB NVMe), India DC, template **"Ubuntu 24.04 with Coolify"** (ADR-0002 supersedes the earlier KVM 8). Dedicated to DevOS; MyBrain stays on srv1834343 (KVM 1), untouched. **Done 30 Oct 2026** — IP shared with Claude. | M0.1 |
| H2 | Cloudflare Zero Trust | Confirm `accelr8.in` is on Cloudflare; enable Zero Trust (free). Access + Tunnel, Google login, for `devos.accelr8.in` and `*.devos.accelr8.in`. | M0.2 |
| H3 | GitHub token | Fine-grained PAT, **All repositories**, 1-year expiry, **Admin + repository-creation + the stated set** (Contents, Issues, Pull requests, Workflows, Actions, Commit statuses, Webhooks, Secrets, Environments, Metadata). Store in the server secret store as `GITHUB_TOKEN`; never in chat. | M0.6 |
| H4 | Anthropic API key | New key, provider-side monthly cap **USD 15** (editable). Store as `ANTHROPIC_API_KEY`. | M0.5 |
| H5 | OpenAI API key | New key (for Codex), provider-side monthly cap **USD 15**. Store as `OPENAI_API_KEY`. | M0.3 |
| H6 | Codex GitHub App — **deferred/optional** | Not required. Codex review runs as the `codex exec review` CLI authenticated by the OpenAI API key (ADR-0002); the GitHub app would need a paid ChatGPT plan and only adds in-PR UI comments. Add later if wanted. | — |
| H7 | Cloudflare R2 bucket | Bucket `devos-backups` + an access key scoped to it, for off-server Postgres backups. Store creds as `R2_*`. | M4.5 |
| H8 | Linear API key | Personal API key in workspace `kishoremb`, so DevOS creates one Linear project per build (M2.6). Enter in the setup wizard. | M2.6 |
| H9 | Enter keys + confirm caps | In the DevOS setup wizard: enter the real keys and confirm the three USD 15 caps (Anthropic, OpenAI, per-project), editable. | Gate G1 |

KK also confirms, in Phase 0, the technical defaults so they can be logged as ADRs: 15-minute deploy probation, 30-day archive window, NFR targets, Uptime Kuma + Sentry monitoring, R2 backup retention.

**Blocking items for the first agent run:** H3 (GitHub token), H4 (Anthropic key), H5 (OpenAI key). H1/H2 gate the server-side modules; H7/H8 are needed later (P4 / P2).

---

## B. What DevOS/Claude does in code — P0 modules (M0.1–M0.6)

These run on KK's existing setup (this environment + the new server) under the normal build loop. DevOS never deploys changes to itself without KK's approval. Each module's contract (`docs/modules/M0.x.md`) is written by the Architect at phase start.

| Module | Lane | Depends on | Done when |
|--------|------|-----------|-----------|
| **M0.1** Server baseline | A (critical path) | H1 | KVM 8 hardened, Coolify private, snapshots on — Coolify reachable only over an SSH tunnel; evidence stored. |
| **M0.2** Private access | A | M0.1, H2 | Cloudflare Tunnel + Access live; `devos.accelr8.in` refuses everyone but KK's Google login. |
| **M0.3** Codex review spike | B | H5 | `codex exec review` (CLI, OpenAI-API-key auth per ADR-0002) returns valid PASS / CHANGES_REQUESTED JSON on a sample repo with a planted bug. |
| **M0.4** Coolify API spike | A (critical path) | M0.1 | Create, deploy, roll back, delete a stack by Coolify API — all four scripted and repeatable (else Dokploy chosen and logged). |
| **M0.5** Agent SDK spike | B | M0.1, H4 | Unattended Agent SDK run in a container with a tool allow-list; a blocked tool call is denied by hook; time + cost recorded. |
| **M0.6** Repo scaffold | C | H3 | Monorepo (dashboard, api, shared), CI, one rules file → CLAUDE.md + AGENTS.md; **CI green on an empty build. ✓ DONE 29 Oct 2026** (commit `4580580`, CI run #40866008923 green). |

**Gate G0 (closes Phase 0):** stored evidence that every spike M0.1–M0.6 has a recorded working run, and any failed spike has chosen its fallback (Dokploy for Coolify; `codex exec` + schema for review).

---

## C. What this environment already covers

- **Repo**: `kkarnati1980/devos` scaffolded and pushed to `main`; CI green (M0.6 ✓). Branch protection on `main` still to be enabled by KK (the agent proxy blocks that API path).
- **Linear**: team Devos / project "AI Development Team" (P-DEVOS-3), 7 milestones P0–P6, 51 issues restored to Backlog, labels, One-way GitHub→Linear sync, PR/branch linking (O10).
- **GitHub**: `devos` repo created (private, `kkarnati1980`); Claude GitHub App scoped to All repositories.

---

## D. Order of operations

1. KK completes H1–H9 (server, Cloudflare, tokens, keys, R2, wizard) — secrets into provider consoles / server store, not chat.
2. DevOS runs the P0 spikes M0.1–M0.5 against the new server (M0.6 already done).
3. Gate G0 evidence captured → Phase 0 closes.
4. Phase 1 (data model, API+auth, dashboard shell, setup wizard, run engine, notifications) begins.
