// M1.6 MyBrain bell transport (PR18-r1, F2 internal-URL block): the bell host is resolved first,
// EVERY resolved address must be public, and the connection is pinned to the checked address (the
// request's `lookup` returns only that address), so DNS cannot point a signed POST at an internal
// service between the check and the connect. No redirects are followed; the response body is
// discarded unread; one deadline covers resolve + connect + response (ADR-0011 §9).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { promises as dns } from "node:dns";

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolve: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, includes the Tailscale range
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can embed a private IPv4 address
  ["fc00::", 7], // unique local, includes Tailscale's fd7a:115c:a1e0::/48
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(a, p, "ipv6");

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** A public unicast address (IPv4-mapped IPv6 is judged by its IPv4 address). */
export function isPublicAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 0) return false;
  if (fam === 6) {
    const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicAddress(m[1]!);
    if (/^::ffff:/i.test(ip)) return false;
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

const isLoopbackAddress = (ip: string) => {
  const fam = net.isIP(ip);
  return fam === 4 ? LOOPBACK.check(ip, "ipv4") : fam === 6 ? LOOPBACK.check(ip, "ipv6") : false;
};

export interface BellRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Test-only: allow a loopback stub (and only loopback) instead of public addresses. */
  allowLoopback?: boolean;
  resolve?: Resolver;
}

/** POSTs the signed bell request. Resolves `null` on any 2xx, or a fixed error code. Never throws. */
export async function postBell(r: BellRequest): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  let req: http.ClientRequest | undefined;
  // PR18-r2: once the deadline passes (or the outcome is known) no request may start, and any
  // request or response still open is destroyed, so nothing is sent or kept open late.
  let done = false;
  const finish = () => {
    done = true;
    req?.destroy();
  };
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      finish();
      resolve("mybrain-timeout");
    }, r.timeoutMs);
  });
  const run = async (): Promise<string | null> => {
    const u = new URL(r.url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const allowed = (ip: string) => (r.allowLoopback ? isLoopbackAddress(ip) || isPublicAddress(ip) : isPublicAddress(ip));
    let addrs: Array<{ address: string; family: number }>;
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
    else {
      try {
        addrs = await (r.resolve ?? defaultResolve)(host);
      } catch {
        return "mybrain-dns";
      }
    }
    if (done) return "mybrain-timeout"; // the resolver answered after the deadline: never send
    if (addrs.length === 0) return "mybrain-dns";
    // Every address must pass, not just the first: a resolver can return mixed answers.
    if (!addrs.every((a) => allowed(a.address))) return "mybrain-blocked-address";
    const pin = addrs[0]!;
    const lib = u.protocol === "https:" ? https : http;
    return new Promise<string | null>((resolve) => {
      req = lib.request(
        {
          protocol: u.protocol,
          hostname: host,
          port: u.port || undefined,
          path: u.pathname + u.search,
          method: "POST",
          headers: { ...r.headers, "content-length": String(Buffer.byteLength(r.body)) },
          servername: net.isIP(host) ? undefined : host,
          agent: false,
          // The connection goes only to the address checked above.
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
            opts && opts.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)) as never,
        },
        (res) => {
          // Only the status matters: the body (untrusted data) is never read, and the response and
          // its connection are destroyed at once, so a stalled or endless body holds nothing open.
          const s = res.statusCode ?? 0;
          res.destroy();
          resolve(s >= 200 && s < 300 ? null : `mybrain-http-${s}`);
        },
      );
      req.on("error", () => resolve("mybrain-network"));
      req.end(r.body);
    });
  };
  try {
    return await Promise.race([run().catch(() => "mybrain-network"), deadline]);
  } finally {
    clearTimeout(timer);
    finish();
  }
}
