import { start } from "../server.mjs";

/** Start the built dashboard (run `next build` first) on a free local port. */
export async function startDashboard(env = {}) {
  const { server, app, cfg } = await start({ HOST: "127.0.0.1", PORT: "0", ...env });
  const { port } = server.address();
  const base = `${cfg.tls ? "https" : "http"}://127.0.0.1:${port}`;
  return {
    base,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await app.close?.();
    },
  };
}

export const NON_CSP_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-dns-prefetch-control": "off",
  "x-permitted-cross-domain-policies": "none",
};

/** Every <script ...> opening tag in an HTML document. */
export function scriptTags(html) {
  return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
}
