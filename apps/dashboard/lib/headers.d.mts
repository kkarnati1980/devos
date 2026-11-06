export function staticSecurityHeaders(): { key: string; value: string }[];
export function buildCsp(nonce: string, apiOrigin?: string | null): string;
export function parseApiOrigin(raw: string | undefined | null): string | null;
export const HSTS: string;
