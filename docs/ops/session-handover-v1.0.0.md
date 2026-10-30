# DevOS build — session handover v1.0.0

Self-contained bootstrap for a fresh Claude Code chat to continue the DevOS build. No prior context needed beyond this file + the repo + Linear.

## 0. What DevOS is
KK's private, autonomous AI development team. It turns a project spec into a built, reviewed, privately hosted app on one always-on server, and maintains it. Personal use only, nothing public. Claude builds, Codex reviews (read-only), KK approves gates. Built itself in phases P0–P6.

## 1. Source of truth (read these first)
- **Repo:** `github.com/kkarnati1980/devos`, branch `main` (HEAD `77e5438` at handover). Read `CLAUDE.md` (= generated from `rules.md`), `docs/decisions/*`, `docs/ops/phase-0-environment.md`, `docs/modules/*`.
- **Linear:** team **Devos** (key DEVOS), project **"AI Development Team"** = **P-DEVOS-3** (there is an empty duplicate P-DEVOS-2 — ignore it). Milestones = phases P0–P6; one issue per module (DEVOS-1…51); gates G0–G5.
- **Decision Record** v1.3.0 + **PRD** v1.1.0 live in the claude.ai project "AI Development Team". ADRs in `docs/decisions/` supersede where noted (see §3). Decision Record is due a v1.3.1 bump folding in ADR-0002/0003 — not yet done.

## 2. Where we are
- Phase **P0 (Setup & spikes)**.
- **M0.6 Repo scaffold (DEVOS-32)** — In Review. Monorepo + CI green (run #40866008923). Formal Codex PASS deferred until the review CLI exists (M0.3); CI is green now.
- **M0.1 Server baseline (DEVOS-33)** — In Progress. Server bought (KVM 4, IP **200.234.41.176**). Script ready: `scripts/phase0/01-server-baseline.sh`. **Next action:** KK runs it in Hostinger's AI web terminal and returns the `----- M0.1 evidence -----` block → close M0.1.
- Everything else in P0+ is Backlog.

## 3. Decisions locked (ADRs)
- **ADR-0001** bootstrap.
- **ADR-0002:** server = **Hostinger KVM 4** (4 vCPU/16 GB/200 GB), IP 200.234.41.176, "Ubuntu 24.04 with Coolify" (supersedes O1's KVM 8). Codex review = **`codex exec review` CLI authenticated by the OpenAI API key** (GitHub app deferred, no ChatGPT plan).
- **ADR-0003:** private access = **Tailscale** (WireGuard mesh, Google SSO, tailnet-only, nothing public) — **supersedes O3/O4 Cloudflare Tunnel+Access**. `accelr8.in` stays untouched at GoDaddy. No Cloudflare for DevOS.
- Pilot (social content-extraction) **deferred** — illustrative only (DEVOS-4 parked). Linear↔GitHub issue sync = **One-way (GitHub→Linear)**; never create GitHub mirrors.

## 4. Secrets & keys (NEVER in chat — into the server's secret store at setup)
- **Held by KK:** Anthropic API key ✓, OpenAI API key ✓ (both $15/mo cap). Server vars `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
- **To create when needed:** GitHub fine-grained token (All repos, Admin+repo-creation+standard set, 1yr) → `GITHUB_TOKEN`; Linear personal API key → `LINEAR_API_KEY`; R2 bucket `devos-backups` + Object-R/W token (Phase 4) → `R2_*`.
- **Dropped:** Cloudflare API token / H2 (Tailscale replaces it).
- Root password / server access stays on KK's side; this environment cannot SSH to the server (egress allow-listed). KK runs server commands himself (Hostinger AI terminal for browser steps; his Mac for SSH-tunnel steps).

## 5. Immediate next steps (in order)
1. KK runs `scripts/phase0/01-server-baseline.sh` on the server → returns evidence → mark **M0.1 (DEVOS-33) Done**, store evidence on the issue.
2. **M0.2 (DEVOS-30) Tailscale:** install `tailscale` on the server, KK auths it (Google) + installs Tailscale on his devices; bind dashboard/Coolify to the tailnet (Tailscale Serve); verify off-tailnet is refused. Write `docs/modules/M0.2.md` first.
3. Remaining P0 spikes: **M0.3** Codex review CLI (needs OpenAI key on server), **M0.4** Coolify API, **M0.5** Agent SDK. Then **G0** gate (evidence for all P0) → P1.
4. KK to-do (not blocking M0.1): GitHub token, Linear key; branch protection on `main` (proxy blocks it from Claude — KK sets it, or orchestrator enforces later).

## 6. LINEAR HOUSEKEEPING (do every build turn)
- Plan lives in team **Devos** / project **P-DEVOS-3**. One issue per module; sub-issues per task small enough for one agent session; human-only work = issues assigned to KK.
- Move issue state as work progresses: Backlog → In Progress → In Review → Done. **Store evidence per commit SHA** (commands, exit codes, output) on the issue; gates close on stored evidence only.
- Labels: Lane (A/B/C), Role, Type (Module/Task/Gate/Human), critical-path, deadlocked.
- **Issue sync is One-way (GitHub→Linear).** Never create GitHub issues from Linear (no mirrors). PRs link to issues by branch name (`kishore/devos-<n>-...`) or `Fixes DEVOS-<n>`.
- **Deadlock:** a task failing 3 attempts (Sonnet, Sonnet, Opus) → label `deadlocked`, card + email to KK, lane moves to next ready task; only dependents wait.

## 7. CONTEXT MANAGEMENT (keep the build chat clean)
- Treat the **repo as source of truth**; read `CLAUDE.md`/`rules.md` + relevant `docs/` before acting. Don't re-derive decisions — check `docs/decisions/`.
- Work **module by module**: read the contract, make the smallest change, one module = one PR, CI + Codex review on the same SHA before merge, merge in dependency order.
- **Grill before build:** non-technical blockers (scope, budget, accounts, legal) → ask KK together; technical calls → decide, log as an ADR, don't ask.
- Secrets never in chat or repo. Commit attribution lines: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + the session line.
- Keep KK informed at draft/limitation boundaries; don't narrate every step.
