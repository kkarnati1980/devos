# ADR-0004 — Close public SSH once tailnet SSH works

- **Status:** accepted (31 Oct 2026, Architect, under D10)
- **Context:** After M0.1, the only public port is SSH 22 with root password auth. fail2ban already locked KK out once (dynamic home IP, mistyped passwords), and public password SSH is the server's largest remaining exposure. ADR-0003 makes the tailnet the access path.
- **Decision:** In M0.2, after SSH over the tailnet is verified (AT3), remove the public `22/tcp` UFW allow. SSH is reachable only from tailnet devices. **Break-glass:** Hostinger's browser console (hPanel) works without network SSH, plus the M0.1 baseline snapshot.
- **Consequences:** Zero publicly reachable ports. fail2ban stays on as defence in depth. Key-only auth becomes optional hardening, not urgent. Re-opening is one command (`ufw allow 22/tcp`) from the console.
