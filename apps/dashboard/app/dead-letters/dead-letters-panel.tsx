"use client";
// DEVOS-77 dead-letter view: run jobs that failed for good (run, reason, attempts, time) with a Retry
// button each. Escaped output only (no raw HTML); the retry is a CSRF-protected POST.
import { useCallback, useEffect, useRef, useState } from "react";
import { DevosApi, explain, type DeadLetter } from "../../lib/api";

export function DeadLettersPanel({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [rows, setRows] = useState<DeadLetter[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.deadLetters();
    if (!r.ok) return setMsg(`${explain(r.code)} (${r.code})`);
    setRows(r.data.deadLetters);
  }, [api]);

  useEffect(() => {
    (async () => {
      const si = await api.connect();
      if (!si.ok) return setMsg(`${explain(si.code)} (${si.code})`);
      await load();
    })();
  }, [api, load]);

  async function retry(jobId: string) {
    setBusy(jobId);
    const r = await api.retryDeadLetter(jobId);
    setBusy(null);
    if (!r.ok) return setMsg(`${explain(r.code)} (${r.code})`);
    setMsg(`Run ${jobId} queued again.`);
    await load();
  }

  if (!rows) return msg ? <p className="panel" role="alert">{msg}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      {msg ? <p className="panel" role="status" data-testid="notice">{msg}</p> : null}
      <section className="panel" data-testid="dead-letters">
        <p className="muted small">Runs that failed for good after their retries. Retry queues one again from its last checkpoint.</p>
        {rows.length === 0 ? <p className="muted" data-testid="dead-letters-empty">No failed runs.</p> : null}
        <ul>
          {rows.map((d) => (
            <li key={d.jobId} data-testid="dead-letter">
              <strong>{d.runId}</strong>{" "}
              <span className="muted small">
                {d.attemptsMade} attempt{d.attemptsMade === 1 ? "" : "s"} · {d.failedAt ? new Date(d.failedAt).toLocaleString() : "time unknown"}
              </span>
              <p>{d.reason || "No reason recorded."}</p>
              <button type="button" onClick={() => retry(d.jobId)} disabled={busy !== null} data-testid={`retry-${d.jobId}`}>
                {busy === d.jobId ? "Retrying…" : "Retry"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
