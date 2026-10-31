# ADR-0004 — Close public SSH once tailnet SSH works

- **Status:** accepted (31 Oct 2026, Architect, under D10)
- **Context:** After M0.1, the only public port is SSH 22 with root password auth. fail2ban already locked KK out once (dynamic home IP, mistyped passwords), and public password SSH is the server's largest remaining exposure. ADR-0003 makes the tailnet the access path.
- **Decision:** In M0.2, after SSH over the tailnet is verified (AT3), remove the public `22/tcp` UFW allow. SSH is reachable only from tailnet devices. **Break-glass:** Hostinger's browser console (hPanel) works without network SSH, plus the M0.1 baseline snapshot.
- **Consequences:** Zero publicly reachable ports. fail2ban stays on as defence in depth. Key-only auth becomes optional hardening, not urgent. Re-opening is one command (`ufw allow 22/tcp`) from the console.

## Amendment (31 Oct 2026, after M0.2 run 5)
Closing 22/tcp to everything except `tailscale0` also blocked **Coolify's own SSH from its container to the host** (observed `UFW BLOCK SRC=172.16.1.6 DST=172.16.0.1 DPT=22`). Coolify manages the `localhost` server over SSH, so its startup checks hung and the Reverb (6001) and terminal (6002) services inside the container never started (container `unhealthy`, UI "Cannot connect to real-time service"). Fix: SSH to the host is allowed from Docker's private ranges only (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), applied by `--close-public-ssh` before the public rule is removed. These sources are not routable from the internet, so port 22 stays closed publicly.
