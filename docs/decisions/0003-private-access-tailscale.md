# ADR-0003 — Private access via Tailscale

- **Status:** accepted (30 Oct 2026)
- **Context:** O3/O4 planned Cloudflare Tunnel + Access (Google login) on `devos.accelr8.in`. In practice `accelr8.in` is registered at **GoDaddy** and is **production** (MyBrain, Postiz, email). Cloudflare's **free** plan only supports Full-zone setup — moving the *entire* `accelr8.in` zone to Cloudflare — while subdomain-only / partial setups are paid (Enterprise/Business). Moving the whole production zone solely to give DevOS private access is disproportionate risk.

## Decision
DevOS dashboard private access = **Tailscale** (WireGuard mesh VPN), **superseding O3/O4's Cloudflare Access + Tunnel** for DevOS's own access.
- The server joins KK's tailnet; the dashboard + Coolify bind to the tailnet interface (Tailscale Serve for HTTPS), reachable only from KK's enrolled devices. Nothing is exposed publicly.
- Authentication: Tailscale SSO with **Google** as the identity provider; optional tailnet ACL limiting to KK's devices.
- The URL MyBrain opens is a tailnet hostname (e.g. `devos.<tailnet>.ts.net`), not `devos.agents.accelr8.in`.
- Free for personal use; **zero changes to `accelr8.in` DNS**.

## Consequences
- **M0.2** becomes "Tailscale private access" (install `tailscale` on the server, enrol, lock services to the tailnet, verify no public exposure).
- **H2** (confirm accelr8.in on Cloudflare / Zero Trust) is **not needed**; the Cloudflare API token (`DEVOS_TOKEN`) is **not needed** for DevOS access.
- The M0.1 baseline (UFW SSH-only, Coolify private) is unchanged and complementary — Tailscale replaces the public ingress path, not the firewall.
- If a future project DevOS builds ever needs a *public* URL, that's decided per-project (Cloudflare Tunnel on a dedicated/separate domain, or similar) — out of scope here.
- Decision Record to bump v1.3.0 → v1.3.1 (O1 = KVM 4 per ADR-0002; O3/O4 = Tailscale per this ADR; Codex = CLI/API-key per ADR-0002).
