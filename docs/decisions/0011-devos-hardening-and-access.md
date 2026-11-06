# ADR-0011 — DevOS self-hardening, dashboard session and key-expiry stance

- **Status:** accepted (5 Nov 2026, KK approval; Architect under D10). Applies to M1.2, M1.3, M1.5, M2.1, M3.8, M4.2–M4.5, S2, S8.
- **Context:** The dashboard creates approval grants and shows untrusted content (specs, web text, agent output, logs). Any web page KK opens on a tailnet device can send requests to the dashboard. O3 turned Tailscale key expiry off.
- **Decision:**
  1. CSRF protection on every state-changing route: SameSite=Strict cookie, Origin/Referer check, and a per-session token.
  2. Escape all output by default, no raw-HTML sinks, a strict CSP, and the full security-header set.
  3. **Dashboard session: 12-hour absolute lifetime**, HttpOnly, SameSite=Strict, rotated at sign-in. Identity comes from Tailscale (O4).
  4. **Approval re-confirmation: off during P1–P4.** It is a setting, default off. A G4 decision card asks KK whether to switch it on before the pilot goes live.
  5. **Tailscale key expiry stays off for now.** KK has a monthly reminder to turn it back on; 90 days is recommended. Tracked as a Human issue in Linear.
  6. Browser-trusted HTTPS for the dashboard is recommended (`tailscale cert` with Traefik, or Serve on a port no container publishes; ADR-0005) so cookies can be `Secure` and HSTS applies. Decided in M1.3.
  7. Signed (HMAC + timestamp) inbound webhooks; signed outbound calls to the MyBrain bell.
  8. CI gates on the devos repo: secret scanning, dependency vulnerabilities (high/critical fail), licence check.
  9. Every outbound call has a timeout. Retries apply only to safe operations, with exponential backoff and jitter. A dead-letter view of failed jobs, with retry, sits on the dashboard.
  10. Migrations must be backward-compatible with the previous release (expand now, contract in a later release), so a Coolify rollback never meets an incompatible schema.
  11. Heartbeat alerts for DevOS's own timers: review watcher, nightly backup, weekly test-restore, 08:00 report.
  12. A disaster-recovery runbook (RTO 4 h, RPO 24 h; Architect defaults, editable) and a rebuild-from-scratch drill.
- **Consequences:** about 3–4 extra Builder sessions folded into P1–P4 modules. Without re-confirmation, a hijacked dashboard session could approve during the build phases. Accepted by KK for P1–P4, mitigated by CSRF protection and the 12-hour session.

**Linear:** the Human issue in §5 is DEVOS-71 (H10); the G4 card in §4 is DEVOS-72.
