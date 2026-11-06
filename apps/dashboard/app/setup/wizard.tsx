"use client";
// M1.4 setup wizard: step 1 the three caps, step 2 every secret, write-only.
import { useEffect, useRef, useState } from "react";
import { DevosApi, SECRET_LABELS, explain, type SecretMeta } from "../../lib/api";
import { formatIst } from "../../lib/format";

type Caps = { anthropicCapUsd: string; openaiCapUsd: string; defaultProjectCapUsd: string };
const CAP_LABELS: Record<keyof Caps, string> = {
  anthropicCapUsd: "Anthropic key, per month (USD)",
  openaiCapUsd: "OpenAI key, per month (USD)",
  defaultProjectCapUsd: "Each project (USD)",
};

export function SetupWizard({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps>({ anthropicCapUsd: "15.00", openaiCapUsd: "15.00", defaultProjectCapUsd: "15.00" });
  const [capsConfirmed, setCapsConfirmed] = useState(false);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await api.signIn();
      if (!s.ok) return setError(`${explain(s.code)} (${s.code})`);
      const [st, set, sec] = await Promise.all([api.setup(), api.settings(), api.secrets()]);
      if (!st.ok) return setError(`${explain(st.code)} (${st.code})`);
      setCapsConfirmed(st.data.capsConfirmed);
      if (set.ok) {
        const v = set.data.settings;
        setCaps({ anthropicCapUsd: v.anthropicCapUsd, openaiCapUsd: v.openaiCapUsd, defaultProjectCapUsd: v.defaultProjectCapUsd });
      }
      if (sec.ok) setSecrets(sec.data.secrets);
      else setError(`${explain(sec.code)} (${sec.code})`);
      setReady(true);
    })();
  }, [api]);

  async function saveCaps(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const r = await api.saveCaps(caps);
    if (!r.ok) return setNotice(`${explain(r.code)} (${r.code})`);
    setCapsConfirmed(true);
    setNotice("Caps saved.");
  }

  async function saveSecret(e: React.FormEvent<HTMLFormElement>, name: string) {
    e.preventDefault();
    const form = e.currentTarget;
    const field = form.elements.namedItem("value") as HTMLInputElement;
    const value = field.value;
    field.value = ""; // never kept in the page, state or URL
    setNotice(null);
    const r = await api.saveSecret(name, value);
    if (!r.ok) return setNotice(`${SECRET_LABELS[name] ?? name}: ${explain(r.code)} (${r.code})`);
    setSecrets((list) => list.map((m) => (m.name === name ? r.data.secret : m)));
    setNotice(`${SECRET_LABELS[name] ?? name} ${r.data.rotated ? "replaced" : "saved"}.`);
  }

  if (error) return <p className="panel" role="alert" data-testid="setup-error">{error}</p>;
  if (!ready) return <p className="muted">Loading…</p>;
  const done = capsConfirmed && secrets.length > 0 && secrets.every((s) => s.set);

  return (
    <>
      {notice ? <p className="panel" role="status" data-testid="notice">{notice}</p> : null}
      <section className="panel" data-testid="caps-step">
        <h2>1. Spending caps {capsConfirmed ? <span className="badge">saved</span> : null}</h2>
        <form onSubmit={saveCaps} className="form">
          {(Object.keys(CAP_LABELS) as (keyof Caps)[]).map((k) => (
            <label key={k}>
              {CAP_LABELS[k]}
              <input
                name={k}
                inputMode="decimal"
                required
                value={caps[k]}
                onChange={(e) => setCaps({ ...caps, [k]: e.target.value })}
              />
            </label>
          ))}
          <button type="submit" data-testid="save-caps">Save caps</button>
        </form>
      </section>
      <section className="panel" data-testid="secrets-step">
        <h2>2. Keys and tokens</h2>
        <p className="muted small">Each value is stored encrypted on the server and never shown again; only its last 4 characters are.</p>
        <ul className="list">
          {secrets.map((m) => (
            <li key={m.name} data-testid={`secret-${m.name}`}>
              <form onSubmit={(e) => saveSecret(e, m.name)} className="form" autoComplete="off">
                <label>
                  {SECRET_LABELS[m.name] ?? m.name}
                  <input name="value" type="password" autoComplete="off" spellCheck={false} required minLength={16} maxLength={4096} />
                </label>
                <span className="muted small" data-testid="secret-state">
                  {m.set ? `•••• ${m.hint ?? ""} · saved ${m.updatedAt ? formatIst(m.updatedAt) : ""}` : "not set"}
                </span>
                <button type="submit">{m.set ? "Replace" : "Save"}</button>
              </form>
            </li>
          ))}
        </ul>
      </section>
      {done ? <p className="panel" data-testid="setup-complete">Setup complete.</p> : null}
    </>
  );
}
