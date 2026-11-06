// Pure helpers shared by next.config.mjs, middleware.ts and server.mjs (M1.3).

/** Headers that are the same on every response (ADR-0011 §2). */
export function staticSecurityHeaders() {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];
}

/**
 * Strict, nonce-based Content-Security-Policy. No 'unsafe-inline', no
 * 'unsafe-eval', no hosts: scripts run only with this request's nonce (and what
 * they load, via 'strict-dynamic'); styles only from this origin or with the nonce.
 * @param {string} nonce base64 nonce, fresh per request
 */
export function buildCsp(nonce) {
  if (!/^[A-Za-z0-9+/]{22,}={0,2}$/.test(nonce)) throw new Error("csp-nonce-invalid");
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types nextjs nextjs#bundler 'allow-duplicates'",
  ].join("; ");
}

export const HSTS = "max-age=31536000; includeSubDomains";
