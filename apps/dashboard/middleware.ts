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
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
    },
  ],
};
