// Tailscale identity (O4, ADR-0003/0005/0011 §3). There is no Tailscale Serve (ADR-0005), so no
// identity header exists. The API asks the local tailscaled which tailnet user owns the TCP peer
// of the request (LocalAPI `whois`). Only the socket peer address is used, never a forwarded header.
import http from "node:http";

export interface TailnetIdentity {
  /** Lower-cased Tailscale login name, e.g. `kk@example.com`. */
  login: string;
  /** The tailnet node that made the request (for logs; not a secret). */
  node: string;
}

/** Resolves the tailnet user behind a TCP peer, or null if it is not a (user-owned) tailnet peer. */
export interface IdentityResolver {
  whois(remoteAddress: string, remotePort: number): Promise<TailnetIdentity | null>;
}

/** Normalise `::ffff:100.64.0.1` to `100.64.0.1`. */
export function peerIp(remoteAddress: string | undefined): string | null {
  if (!remoteAddress) return null;
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(remoteAddress);
  return v4mapped ? v4mapped[1]! : remoteAddress;
}

/** `ip:port` as the LocalAPI expects (IPv6 in brackets). */
export function whoisAddr(ip: string, port: number): string {
  return ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/** Calls tailscaled's LocalAPI over its unix socket, with a hard timeout (ADR-0011 §9). */
export class TailscaleWhoisResolver implements IdentityResolver {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
  ) {}

  whois(remoteAddress: string, remotePort: number): Promise<TailnetIdentity | null> {
    const ip = peerIp(remoteAddress);
    if (!ip || !Number.isInteger(remotePort) || remotePort <= 0) return Promise.resolve(null);
    const path = `/localapi/v0/whois?addr=${encodeURIComponent(whoisAddr(ip, remotePort))}`;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.socketPath, path, method: "GET", headers: { Host: "local-tailscaled.sock" }, timeout: this.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 256 * 1024) {
              req.destroy(new Error("whois-response-too-large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            // 404 = not a tailnet peer (e.g. a LAN or Docker address).
            if (res.statusCode === 404) return resolve(null);
            if (res.statusCode !== 200) return reject(new Error(`whois-status-${res.statusCode}`));
            try {
              resolve(parseWhois(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
            } catch {
              reject(new Error("whois-response-invalid"));
            }
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("whois-timeout")));
      req.on("error", reject);
      req.end();
    });
  }
}

/** Extract the user login from a LocalAPI whois response. Tagged (non-user) nodes yield null. */
export function parseWhois(body: unknown): TailnetIdentity | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { Node?: { Name?: unknown; Tags?: unknown }; UserProfile?: { LoginName?: unknown } };
  if (Array.isArray(b.Node?.Tags) && b.Node!.Tags.length > 0) return null;
  const login = b.UserProfile?.LoginName;
  if (typeof login !== "string" || !login.includes("@")) return null;
  const node = typeof b.Node?.Name === "string" ? b.Node.Name : "";
  return { login: login.trim().toLowerCase(), node };
}
