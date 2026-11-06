import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const dynamic = "force-dynamic"; // every page is rendered per request, so each carries this request's CSP nonce

export const metadata: Metadata = {
  title: "DevOS",
  description: "DevOS dashboard",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers opts out of static prerendering (nonce must be per request).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en-IN">
      <body data-nonce-set={nonce ? "1" : "0"}>
        <header className="top">
          <a className="brand" href="/">DevOS</a>
          <span className="mode">mock data</span>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
