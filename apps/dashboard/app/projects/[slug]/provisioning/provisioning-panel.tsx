"use client";
// M2.4-d2 (DEVOS-225, docs/modules/M2.4.md "M2.4-d2 decisions"): the project page's "Provisioning" section. One row
// per step with a plain-language status and the step's fixed code; "Try again" only when the run is parked. Escaped
// output only (strict nonce CSP); the retry is a POST with the session's CSRF token (DevosApi adds it).
import { useCallback, useEffect, useRef, useState } from "react";
import { DevosApi, explain, type ProvisionStepView, type ProvisionView } from "../../../../lib/api";

const CODE_TEXT: Record<string, string> = {
  name_conflict: "needs your decision: something with this name already exists (see Approvals)",
  approval_required: "blocked by a policy rule that asks for approval (a grant for this step is needed)",
  policy_denied: "not allowed by policy",
  port_range_exhausted: "no free port left",
  compose_drift: "the deploy file was changed by hand",
};

export function stepText(s: ProvisionStepView): string {
  if (s.status === "done") return "done";
  if (s.status === "pending") return "waiting";
  return s.code && CODE_TEXT[s.code] ? CODE_TEXT[s.code]! : "failed";
}

const panelError = (code: string): string =>
  code === "project-not-found" ? "Provisioning has not started for this project." :
  code === "provision-not-configured" ? "Provisioning is not switched on on the server yet." :
  code === "provision-store-failed" ? "The provisioning status could not be read. Try again in a minute." :
  code === "project-not-provisioning" ? "This project is no longer being set up." :
  explain(code);

export function ProvisioningPanel({ apiOrigin, slug }: { apiOrigin: string; slug: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [view, setView] = useState<ProvisionView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (live: () => boolean) => {
    const si = await api.connect();
    if (!live()) return;
    if (!si.ok) return setMsg(`${panelError(si.code)} (${si.code})`);
    const r = await api.provision(slug);
    if (!live()) return;
    if (r.ok) { setView(r.data); setMsg(null); }
    else { setView(null); setMsg(`${panelError(r.code)} (${r.code})`); }
  }, [api, slug]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  const retry = async () => {
    if (!view) return;
    setBusy(true);
    const r = await api.retryProvision(view.projectId);
    setBusy(false);
    if (r.ok) { setNote("Queued: DevOS will try again within a minute."); await load(() => true); }
    else setNote(`${panelError(r.code)} (${r.code})`);
  };

  return (
    <section className="panel" aria-labelledby="provisioning-h" data-testid="provisioning-panel">
      <h2 id="provisioning-h">Provisioning</h2>
      {msg ? <p className="muted" data-testid="provisioning-error">{msg}</p> : null}
      {!msg && !view ? <p className="muted">Loading…</p> : null}
      {view && view.steps.length === 0 ? <p className="muted" data-testid="provisioning-empty">No steps have run yet.</p> : null}
      {view && view.steps.length > 0 ? (
        <ul className="list">
          {view.steps.map((s) => (
            <li key={s.key} data-testid="provisioning-step">
              <code>{s.key}</code> — {stepText(s)}
              {s.code ? <span className="muted small"> ({s.code})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view?.parked ? (
        <p>
          Setting up this project stopped.{" "}
          <button type="button" onClick={() => void retry()} disabled={busy} data-testid="provisioning-retry">Try again</button>
        </p>
      ) : null}
      {note ? <p className="muted" data-testid="provisioning-note">{note}</p> : null}
    </section>
  );
}
