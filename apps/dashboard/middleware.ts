// M1.3: per-request nonce and strict CSP (ADR-0011 §2). Next.js reads the nonce
// from the request's Content-Security-Policy header and puts it on every script
// it emits; pages are rendered per request (layout reads headers()), so a
// prerendered page can never carry a stale nonce.
import { NextResponse, type NextRequest } from "next/server";

import { buildCsp } from "./lib/headers.mjs";

function newNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp: string = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // Hashed build assets may be cached; everything else (pages, 404s) is no-store.
  if (!request.nextUrl.pathname.startsWith("/_next/static/")) response.headers.set("Cache-Control", "no-store");
  return response;
}

// No matcher: middleware runs on every path, so every response — pages, HTML
// 404s and error pages, and static assets — carries the strict CSP (PR15-r1).
