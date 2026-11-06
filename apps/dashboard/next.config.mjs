// M1.3 dashboard shell. Security headers that do not depend on the per-request
// nonce are set here for every path (static assets included); the CSP itself is
// set per request in middleware.ts (nonce-based, ADR-0011 §2).
import { staticSecurityHeaders } from "./lib/headers.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  eslint: { ignoreDuringBuilds: true }, // lint is scripts/no-raw-html.mjs
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: staticSecurityHeaders() }];
  },
};

export default nextConfig;
