# DevOS

KK's private AI development team. DevOS turns a project spec into a built, reviewed, privately hosted app on one always-on server, and maintains it — with KK asked only at defined gates.

- **Plan / tracker:** Linear — team **Devos**, project **AI Development Team** (issues `DEVOS-…`).
- **Build:** Claude (Architect, Builder, Tester) via the Claude Agent SDK. **Review:** Codex, read-only.
- **Hosting:** one Hostinger KVM 4 running Coolify (ADR-0002); each project is a Docker Compose stack. Private access is over KK's Tailscale tailnet only, with no public ports (ADR-0003/0004/0005).
- **Source of truth for decisions:** DevOS Decision Record v1.3.0 and PRD (claude.ai project "AI Development Team").

This repo is the DevOS build itself. See `docs/ops/phase-0-environment.md` for server setup, `rules.md` for the agent rulebook, and `docs/modules/` for per-module contracts.

Proprietary — © 2026 Kishore Karnati / Kiot Innovations Pvt. Ltd. All rights reserved.
