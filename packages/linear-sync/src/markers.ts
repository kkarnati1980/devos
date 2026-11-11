// Idempotency markers (docs/modules/M2.6.md): every Linear object DevOS creates carries a hidden HTML comment
// naming the DevOS row it mirrors, so a crash between "created in Linear" and "id saved in DevOS" is recovered
// by searching for the marker instead of creating a duplicate. Only the marker is ever parsed from Linear text.
export type MarkerKind = "project" | "milestone" | "module" | "task";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function marker(kind: MarkerKind, id: string): string {
  if (!UUID.test(id)) throw new Error(`marker: not a uuid for ${kind}`);
  return `<!-- devos:${kind}:${id} -->`;
}

export function withMarker(text: string, kind: MarkerKind, id: string): string {
  const m = marker(kind, id);
  const clean = stripMarkers(text).trimEnd();
  return clean ? `${clean}\n\n${m}` : m;
}

export function stripMarkers(text: string): string {
  return text.replace(/\n*<!-- devos:(project|milestone|module|task):[0-9a-f-]{36} -->/g, "");
}

/** The DevOS id named by the marker of this kind in Linear text, or null. Anything else in the text is ignored. */
export function readMarker(text: string | null | undefined, kind: MarkerKind): string | null {
  if (!text) return null;
  const m = text.match(new RegExp(`<!-- devos:${kind}:([0-9a-f-]{36}) -->`));
  const id = m?.[1];
  return id && UUID.test(id) ? id : null;
}
