"use client";
// M1.4 settings: the three caps, default lanes and deadlock attempts (all editable).
import { useEffect, useRef, useState } from "react";
import { DevosApi, explain, type SettingsView } from "../../lib/api";

export function SettingsForm({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [s, setS] = useState<SettingsView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const si = await api.connect();
      if (!si.ok) return setNotice(`${explain(si.code)} (${si.code})`);
      const r = await api.settings();
      if (!r.ok) return setNotice(`${explain(r.code)} (${r.code})`);
      setS(r.data.settings);
    })();
  }, [api]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    const r = await api.saveSettings({
      anthropicCapUsd: s.anthropicCapUsd,
      openaiCapUsd: s.openaiCapUsd,
      defaultProjectCapUsd: s.defaultProjectCapUsd,
      defaultLanes: s.defaultLanes,
      deadlockAttempts: s.deadlockAttempts,
    });
    if (!r.ok) return setNotice(`${explain(r.code)} (${r.code})`);
    setS(r.data.settings);
    setNotice("Settings saved.");
  }

  if (!s) return notice ? <p className="panel" role="alert">{notice}</p> : <p className="muted">Loading…</p>;
  const lanes = Array.from({ length: s.maxLanes }, (_, i) => i + 1);
  return (
    <>
      {notice ? <p className="panel" role="status" data-testid="notice">{notice}</p> : null}
      <form onSubmit={save} className="panel form" data-testid="settings-form">
        <label>Anthropic cap, per month (USD)<input name="anthropicCapUsd" inputMode="decimal" required value={s.anthropicCapUsd} onChange={(e) => setS({ ...s, anthropicCapUsd: e.target.value })} /></label>
        <label>OpenAI cap, per month (USD)<input name="openaiCapUsd" inputMode="decimal" required value={s.openaiCapUsd} onChange={(e) => setS({ ...s, openaiCapUsd: e.target.value })} /></label>
        <label>Default cap per project (USD)<input name="defaultProjectCapUsd" inputMode="decimal" required value={s.defaultProjectCapUsd} onChange={(e) => setS({ ...s, defaultProjectCapUsd: e.target.value })} /></label>
        <label>
          Default lanes per project
          <select name="defaultLanes" value={s.defaultLanes} onChange={(e) => setS({ ...s, defaultLanes: Number(e.target.value) })}>
            {lanes.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>
          Failed attempts before a task is deadlocked
          <select name="deadlockAttempts" value={s.deadlockAttempts} onChange={(e) => setS({ ...s, deadlockAttempts: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="submit" data-testid="save-settings">Save settings</button>
      </form>
    </>
  );
}
