"use client";
// M2.3-b2 (DEVOS-135): the nav link "Approvals" with its pending count. It reads only once a page's
// DevosApi holds a session (see SESSION_EVENT in lib/api.ts) and refreshes after an approval changes.
// No count is shown on pages that never open a session, or when the read fails.
import { useEffect, useState } from "react";
import { APPROVALS_CHANGED_EVENT, DevosApi, hasSession, SESSION_EVENT } from "../../lib/api";

export function ApprovalsNavLink({ apiOrigin }: { apiOrigin: string | null }) {
  const [count, setCount] = useState<string | null>(null);
  useEffect(() => {
    if (!apiOrigin) return;
    const api = new DevosApi(apiOrigin); // GETs only: no CSRF token, no sign-in
    let alive = true;
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      const r = await api.approvals({ status: "pending" });
      if (!alive || mine !== seq) return; // only the newest read wins
      if (!r.ok) return setCount(null);
      const n = r.data.approvals.length;
      setCount(r.data.nextCursor ? `${n}+` : String(n));
    };
    if (hasSession()) void load();
    window.addEventListener(SESSION_EVENT, load);
    window.addEventListener(APPROVALS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(SESSION_EVENT, load);
      window.removeEventListener(APPROVALS_CHANGED_EVENT, load);
    };
  }, [apiOrigin]);
  return (
    <a href="/approvals" data-testid="nav-approvals">
      Approvals{count !== null && count !== "0" ? <span className="muted small" data-testid="nav-pending"> ({count} pending)</span> : null}
    </a>
  );
}
