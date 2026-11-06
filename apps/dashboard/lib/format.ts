// Formatting only; never builds HTML. React escapes every string it renders.
const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatIst(isoTime: string): string {
  const d = new Date(isoTime);
  return Number.isNaN(d.getTime()) ? "—" : `${IST.format(d)} IST`;
}

export function formatUsd(value: number): string {
  return `USD ${value.toFixed(2)}`;
}

export function label(value: string): string {
  return value.replace(/_/g, " ");
}

/** Only http(s) links are ever rendered as hrefs; anything else is shown as text. */
export function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
