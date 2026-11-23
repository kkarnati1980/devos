# 0036 — Tailscale subnet-route SNAT off on the DevOS server (S4-d, DEVOS-251)

Date: 23 Nov 2026 (runner B, ADR-0013). Contract: `docs/modules/S4.md` "S4-d Tailnet peer kept".

## Decision
The server agent keeps tailscaled's preference `NoSNAT` true on the DevOS server (`tailscale set --snat-subnet-routes=false`), every tick, through the allow-listed `scripts/server/tailnet-snat.sh`. It does this only while the host advertises no routes; a subnet router or exit node is left alone and reported, because changing it there is KK's call. The server check `api-tailnet-peer.sh` fails when `NoSNAT` is false or when conntrack shows a tailnet client whose reply goes elsewhere.

## Why
M1.2's identity check (AccessGuard) asks `tailscale whois` about the connection's peer address. With subnet-route SNAT on (the default), tailscaled masquerades every forwarded packet that came in on `tailscale0`, which includes every connection to a port Docker publishes. The API then sees the bridge gateway, `whois` finds no user, and KK is refused (`not-kk`, DEVOS-89, 23 Nov 2026). The preference exists for subnet routers; this host is not one, so turning it off costs nothing here.

## Rejected
- Trusting the bridge gateway, or a forwarded header, as KK: any process on the host or in a container could then act as KK.
- An own nat rule ahead of tailscaled's chain: tailscaled re-creates its chains on restart (and runs in nftables mode here), so the rule could silently lose.
- No change to the identity check itself.
