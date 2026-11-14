"use client";
// ADR-0012 CR-a3 (DEVOS-199): the read-only pre-flight section of the project page. It shows the intake state, the
// list KK saw on the intake card with each default or his recorded answer, and "waiting for secrets" when the card
// is approved but a secret is not yet in the vault. Reads only; escaped output only (strict nonce CSP).
import { useEffect, useRef, useState } from "react";
import { DevosApi, explain, type PreflightView } from "../../../lib/api";

const STATE_TEXT: Record<string, string> = {
  pending: "Waiting for your decision on the intake card in Approvals.",
  approved: "Intake card approved.",
  rejected: "Intake card rejected. Upload a revised spec to start again.",
};

export function PreflightPanel({ apiOrigin, slug }: { apiOrigin: string; slug: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [view, setView] = useState<PreflightView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      // Same as the other API panels: connect (KK's tailnet session), then read.
      const si = await api.connect();
      if (!live) return;
      if (!si.ok) return setMsg(`${explain(si.code)} (${si.code})`);
      const r = await api.preflight(slug);
      if (!live) return;
      if (r.ok) setView(r.data.preflight);
      else setMsg(`${explain(r.code)} (${r.code})`);
    })();
    return () => {
      live = false;
    };
  }, [api, slug]);

  return (
    <section className="panel" aria-labelledby="preflight-h" data-testid="preflight-panel">
      <h2 id="preflight-h">Pre-flight</h2>
      {msg ? <p className="muted" data-testid="preflight-error">{msg}</p> : null}
      {!msg && !view ? <p className="muted">Loading…</p> : null}
      {view ? <PreflightBody view={view} /> : null}
    </section>
  );
}

function PreflightBody({ view }: { view: PreflightView }) {
  if (!view.continuousRun && view.items.length === 0) {
    return <p className="muted" data-testid="preflight-off">This project does not use continuous-run mode; there is no pre-flight.</p>;
  }
  // The newest recorded answer per item (the log is oldest first).
  const answers = new Map<string, { answer: string; source: string }>();
  for (const d of view.decisions) answers.set(d.itemId, { answer: d.answer, source: d.source });
  const waiting = view.state === "approved" && view.missingSecrets.length > 0;
  return (
    <>
      <p data-testid="preflight-state">{STATE_TEXT[view.state ?? ""] ?? "Pre-flight state unknown."} {view.open ? "The build may start." : "The build has not started."}</p>
      {waiting ? (
        <p data-testid="preflight-waiting">
          <strong>waiting for secrets:</strong> {view.missingSecrets.join(", ")}
          {view.secretsUnverified ? " (the vault could not be checked)" : ""} — enter them in the setup wizard.
        </p>
      ) : null}
      <ul className="list">
        {view.items.map((it) => {
          const a = answers.get(it.id);
          return (
            <li key={it.id} data-testid="preflight-item">
              <strong>{it.id}</strong>{" "}
              {it.kind === "secret" ? (
                <>secret <code>{it.text}</code> ({view.missingSecrets.includes(it.text) ? "missing" : "set"})</>
              ) : (
                <>
                  {it.text}
                  <div className="muted small">
                    {a ? `${a.source === "kk" ? "Your answer" : "Default used"}: ${a.answer}` : `Default: ${it.default}`}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
