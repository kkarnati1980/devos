"use client";
// ADR-0012 CR-b2c (DEVOS-216): the read-only "Build questions" section of the project page. It lists each daily batch
// card with every question (the card itself shows at most 2,000 characters), the answer recorded with the card, and
// the tasks a rejected or expired card stopped. Reads only; escaped output only (strict nonce CSP).
import { useEffect, useRef, useState } from "react";
import { DevosApi, explain, type BatchView, type BatchesView } from "../../../lib/api";

function cardText(b: BatchView): string {
  if (b.state === "raising") return "Card not raised yet.";
  if (b.state === "refused") return b.handedOff ? "The card was refused; its questions were handed to the main approvals list." : "The card was refused.";
  switch (b.cardStatus) {
    case "pending":
      return "Waiting for your answers on the card in Approvals.";
    case "approved":
      return b.applied ? "Approved; the answers below were applied." : "Approved; the answers are being applied.";
    case "rejected":
      return "Rejected. The tasks below stay stopped.";
    case "expired":
      return "Expired without an answer. The tasks below stay stopped.";
    default:
      return "Card state unknown.";
  }
}

export function BatchesPanel({ apiOrigin, slug }: { apiOrigin: string; slug: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [view, setView] = useState<BatchesView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const si = await api.connect();
      if (!live) return;
      if (!si.ok) return setMsg(`${explain(si.code)} (${si.code})`);
      const r = await api.batches(slug);
      if (!live) return;
      if (r.ok) setView(r.data.batches);
      else setMsg(r.code === "project-not-found" ? `No build questions for this project yet. (${r.code})` : `${explain(r.code)} (${r.code})`);
    })();
    return () => {
      live = false;
    };
  }, [api, slug]);

  return (
    <section className="panel" aria-labelledby="batches-h" data-testid="batches-panel">
      <h2 id="batches-h">Build questions</h2>
      {msg ? <p className="muted" data-testid="batches-error">{msg}</p> : null}
      {!msg && !view ? <p className="muted">Loading…</p> : null}
      {view ? <BatchesBody view={view} /> : null}
    </section>
  );
}

function BatchesBody({ view }: { view: BatchesView }) {
  if (view.batches.length === 0 && view.waitingCount === 0) {
    return <p className="muted" data-testid="batches-empty">No build questions so far.</p>;
  }
  return (
    <>
      {view.waitingCount ? (
        <p data-testid="batches-waiting">{view.waitingCount} question{view.waitingCount === 1 ? "" : "s"} will join the next daily card.</p>
      ) : null}
      {view.truncated ? (
        <p className="muted small" data-testid="batches-truncated">Some older questions are not shown here (the list is capped); they are on their cards in Approvals.</p>
      ) : null}
      {view.batches.map((b) => (
        <article key={b.id} className="mcard" data-testid="batch">
          <h3>
            {b.istDay} <span className="muted small">({b.questions.length} question{b.questions.length === 1 ? "" : "s"})</span>
          </h3>
          <p className="small" data-testid="batch-state">{cardText(b)}</p>
          <ul className="list">
            {b.questions.map((q) => (
              <li key={q.ref} data-testid="batch-question">
                <strong>{q.ref}</strong> {q.text}
                <div className="muted small">
                  {q.answer !== null ? `${q.answerSource === "kk" ? "Your answer" : "Default used"}: ${q.answer}` : `Default: ${q.default}`}
                </div>
              </li>
            ))}
          </ul>
          {b.stoppedTasks.length ? (
            <>
              <p className="small"><strong>Stopped tasks</strong></p>
              <ul className="list">
                {b.stoppedTasks.map((t) => (
                  <li key={t.id} data-testid="batch-stopped-task">{t.title}</li>
                ))}
              </ul>
            </>
          ) : null}
        </article>
      ))}
    </>
  );
}
