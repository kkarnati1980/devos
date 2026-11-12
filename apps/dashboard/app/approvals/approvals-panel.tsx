"use client";
// M2.3-b2 (DEVOS-135): approvals inbox (pending first, then decided) and the detail of one card with Approve
// (expiry and uses; purge asks for the typed phrase), Reject (comment) and comments. Escaped output only (no raw
// HTML, strict nonce CSP); every POST is CSRF-protected by DevosApi.
import { useCallback, useEffect, useRef, useState } from "react";
import { DevosApi, explain, type ApprovalDetail, type ApprovalRow } from "../../lib/api";

const ORDER: Record<string, number> = { pending: 0, approved: 1, rejected: 1, expired: 1 };

export function ApprovalsPanel({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [open, setOpen] = useState<ApprovalDetail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (code: string) => setMsg(`${explain(code)} (${code})`);

  const load = useCallback(async () => {
    const r = await api.approvals();
    if (!r.ok) return fail(r.code);
    // Stable: pending first, then decided; each group keeps the API's newest-first order.
    setRows([...r.data.approvals].sort((a, b) => (ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1)));
  }, [api]);

  const show = useCallback(async (id: string) => {
    const r = await api.approval(id);
    if (!r.ok) return fail(r.code);
    setOpen(r.data);
  }, [api]);

  useEffect(() => {
    (async () => {
      const si = await api.connect();
      if (!si.ok) return fail(si.code);
      await load();
      const id = new URLSearchParams(window.location.search).get("id");
      if (id) await show(id);
    })();
  }, [api, load, show]);

  async function act(run: () => Promise<{ ok: boolean; code?: string }>, done: string) {
    setBusy(true);
    const r = await run();
    setBusy(false);
    if (!r.ok) return fail(r.code ?? "unknown");
    setMsg(done);
    await load();
    if (open) await show(open.approval.id);
  }

  if (!rows) return msg ? <p className="panel" role="alert">{msg}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      {msg ? <p className="panel" role="status" data-testid="notice">{msg}</p> : null}
      <section className="panel" data-testid="approvals">
        {rows.length === 0 ? <p className="muted" data-testid="approvals-empty">No approval cards.</p> : null}
        <ul>
          {rows.map((c) => (
            <li key={c.id} data-testid="approval-row" data-status={c.status}>
              <button type="button" className="link" onClick={() => show(c.id)} data-testid={`open-${c.id}`}>
                <strong>{c.action}</strong> · {c.target}
              </button>{" "}
              <span className="muted small">
                {c.status} · gate {c.gate}
                {c.costUsd ? ` · $${c.costUsd}` : ""} · {c.blockedTasks} blocked task{c.blockedTasks === 1 ? "" : "s"}
              </span>
              <p>{c.reason}</p>
            </li>
          ))}
        </ul>
      </section>
      {open ? <Detail key={open.approval.id} d={open} busy={busy} act={act} api={api} /> : null}
    </>
  );
}

function Detail({ d, busy, act, api }: {
  d: ApprovalDetail;
  busy: boolean;
  act: (run: () => Promise<{ ok: boolean; code?: string }>, done: string) => Promise<void>;
  api: DevosApi;
}) {
  const c = d.approval;
  const [hours, setHours] = useState("72");
  const [uses, setUses] = useState("1");
  const [phrase, setPhrase] = useState("");
  const [comment, setComment] = useState("");
  const pending = c.status === "pending";
  const purge = c.gate === "purge";
  return (
    <section className="panel" data-testid="approval-detail">
      <h2>{c.action}</h2>
      <dl>
        <dt>Target</dt><dd>{c.target}</dd>
        <dt>Reason</dt><dd>{c.reason}</dd>
        {c.consequence ? <><dt>Consequence</dt><dd>{c.consequence}</dd></> : null}
        <dt>Status</dt><dd data-testid="detail-status">{c.status}{c.decidedBy ? ` by ${c.decidedBy}` : ""}</dd>
        {d.grant ? (
          <><dt>Grant</dt><dd data-testid="detail-grant">
            {d.grant.scopeAction} on {d.grant.scopeResource} · {d.grant.uses}/{d.grant.maxUses} uses
            {d.grant.expiresAt ? ` · until ${new Date(d.grant.expiresAt).toLocaleString()}` : ""}{d.grant.revoked ? " · revoked" : ""}
          </dd></>
        ) : null}
      </dl>
      {d.blockedTasks.length ? (
        <><h3>Blocked tasks</h3><ul>{d.blockedTasks.map((t) => <li key={t.id}>{t.title} <span className="muted small">{t.status}</span></li>)}</ul></>
      ) : null}
      {pending ? (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.approve(c.id, { expiresInHours: Number(hours), maxUses: Number(uses), ...(purge ? { confirmation: phrase } : {}) }), "Approved."); }}>
          <label>Valid for (hours) <input type="number" min={1} max={2160} value={hours} onChange={(e) => setHours(e.target.value)} data-testid="approve-hours" /></label>
          <label>Uses <input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(e.target.value)} data-testid="approve-uses" /></label>
          {purge ? <label>Type the confirmation phrase <input value={phrase} onChange={(e) => setPhrase(e.target.value)} data-testid="approve-phrase" /></label> : null}
          <button type="submit" disabled={busy} data-testid="approve">Approve</button>
        </form>
      ) : null}
      {pending ? (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.reject(c.id, comment.trim() || undefined), "Rejected."); }}>
          <label>Why (optional) <input value={comment} onChange={(e) => setComment(e.target.value)} data-testid="reject-comment" /></label>
          <button type="submit" disabled={busy} data-testid="reject">Reject</button>
        </form>
      ) : null}
      <h3>Comments</h3>
      <ul data-testid="comments">{d.comments.map((m) => <li key={m.id}><strong>{m.author}</strong> <span className="muted small">{m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</span><p>{m.body}</p></li>)}</ul>
      <CommentForm busy={busy} onSend={(body) => act(() => api.commentApproval(c.id, body), "Comment added.")} />
    </section>
  );
}

function CommentForm({ busy, onSend }: { busy: boolean; onSend: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) void onSend(body.trim()).then(() => setBody("")); }}>
      <label>Comment <textarea value={body} onChange={(e) => setBody(e.target.value)} data-testid="comment-body" /></label>
      <button type="submit" disabled={busy || !body.trim()} data-testid="comment-send">Add comment</button>
    </form>
  );
}
