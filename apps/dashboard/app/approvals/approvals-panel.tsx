"use client";
// M2.3-b2 (DEVOS-135): approvals inbox (pending first, then decided) and the detail of one card with Approve
// (expiry and uses; purge asks for the typed phrase), Reject (comment) and comments. Escaped output only (no raw
// HTML, strict nonce CSP); every POST is CSRF-protected by DevosApi.
import { useCallback, useEffect, useRef, useState } from "react";
import { APPROVALS_CHANGED_EVENT, DevosApi, explain, type ApprovalDetail, type ApprovalRow } from "../../lib/api";

const MAX_PENDING_PAGES = 20; // 50 a page (b1); far above what one person's inbox holds
const DECIDED = ["approved", "rejected", "expired"] as const;
type Cursors = Partial<Record<(typeof DECIDED)[number], string>>;
const newestFirst = (a: ApprovalRow, b: ApprovalRow) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

export function ApprovalsPanel({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [more, setMore] = useState<Cursors>({}); // next page per decided status

  const [open, setOpen] = useState<ApprovalDetail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (code: string) => setMsg(`${explain(code)} (${code})`);

  /** One page of each decided status (from `cursors`, or the first pages), newest first. */
  const decidedPage = useCallback(async (cursors: Cursors | null) => {
    const got: ApprovalRow[] = [];
    const next: Cursors = {};
    for (const status of DECIDED) {
      if (cursors && !cursors[status]) continue;
      const r = await api.approvals({ status, cursor: cursors?.[status] });
      if (!r.ok) return { ok: false as const, code: r.code };
      got.push(...r.data.approvals);
      if (r.data.nextCursor) next[status] = r.data.nextCursor;
    }
    return { ok: true as const, rows: got.sort(newestFirst), next };
  }, [api]);

  // Pending first (every page of them), then decided cards read per status (approved, rejected, expired), so
  // neither group can be pushed out of view by the other; older decided cards load with "Show more".
  const load = useCallback(async () => {
    const pending: ApprovalRow[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PENDING_PAGES; i++) {
      const r = await api.approvals({ status: "pending", cursor });
      if (!r.ok) return fail(r.code);
      pending.push(...r.data.approvals);
      if (!r.data.nextCursor) break;
      cursor = r.data.nextCursor;
    }
    const decided = await decidedPage(null);
    if (!decided.ok) return fail(decided.code);
    setMore(decided.next);
    setRows([...pending, ...decided.rows]);
  }, [api, decidedPage]);

  async function showMore() {
    const decided = await decidedPage(more);
    if (!decided.ok) return fail(decided.code);
    setMore(decided.next);
    setRows((prev) => {
      const seen = new Set((prev ?? []).map((c) => c.id));
      return [...(prev ?? []), ...decided.rows.filter((c) => !seen.has(c.id))];
    });
  }

  // Only the newest detail request may fill the panel, so a slow earlier click never replaces the chosen card.
  const showSeq = useRef(0);
  const chosen = useRef<string | null>(null); // the card KK picked last, even while its read is in flight
  const show = useCallback(async (id: string) => {
    chosen.current = id;
    const mine = ++showSeq.current;
    const r = await api.approval(id);
    if (mine !== showSeq.current) return;
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

  async function act(run: () => Promise<{ ok: boolean; code?: string }>, done: string): Promise<boolean> {
    setBusy(true);
    const r = await run();
    setBusy(false);
    const ok = r.ok;
    if (ok) {
      setMsg(done);
      window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT)); // the nav's pending count
    }
    // Re-read after a failure too: a card decided elsewhere (card-not-pending) must stop offering Approve.
    await load();
    if (chosen.current) await show(chosen.current);
    if (!ok) fail(r.code ?? "unknown");
    return ok;
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
        {Object.keys(more).length ? (
          <button type="button" onClick={() => void showMore()} data-testid="approvals-more">Show more decided cards</button>
        ) : null}
      </section>
      {open ? <Detail key={open.approval.id} d={open} busy={busy} act={act} api={api} /> : null}
    </>
  );
}

function Detail({ d, busy, act, api }: {
  d: ApprovalDetail;
  busy: boolean;
  act: (run: () => Promise<{ ok: boolean; code?: string }>, done: string) => Promise<boolean>;
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
            {d.grant.scopeAction}{d.grant.scopeResource ? ` on ${d.grant.scopeResource}` : ""} · {d.grant.uses}/{d.grant.maxUses} uses
            {d.grant.expiresAt ? ` · until ${new Date(d.grant.expiresAt).toLocaleString()}` : ""}{d.grant.revoked ? " · revoked" : ""}
          </dd></>
        ) : null}
      </dl>
      {d.blockedTasks.length ? (
        <><h3>Blocked tasks</h3><ul>{d.blockedTasks.map((t) => <li key={t.id}>{t.title} <span className="muted small">{t.status}</span></li>)}</ul></>
      ) : null}
      {pending ? (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.approve(c.id, { expiresInHours: Number(hours), maxUses: Number(uses), ...(purge ? { confirmation: phrase } : {}) }), "Approved."); }}>
          <label>Valid for (hours) <input type="number" required min={1} max={2160} step={1} value={hours} onChange={(e) => setHours(e.target.value)} data-testid="approve-hours" /></label>
          <label>Uses <input type="number" required min={1} max={100} step={1} value={uses} onChange={(e) => setUses(e.target.value)} data-testid="approve-uses" /></label>
          {purge ? (
            <label>Type <code data-testid="purge-phrase">PURGE {c.target}</code> to confirm the deletion
              <input value={phrase} required onChange={(e) => setPhrase(e.target.value)} data-testid="approve-phrase" autoComplete="off" /></label>
          ) : null}
          <button type="submit" disabled={busy} data-testid="approve">Approve</button>
        </form>
      ) : null}
      {pending ? (
        <form onSubmit={(e) => { e.preventDefault(); void act(() => api.reject(c.id, comment.trim() || undefined), "Rejected."); }}>
          <label>Why (optional) <input value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} data-testid="reject-comment" /></label>
          <button type="submit" disabled={busy} data-testid="reject">Reject</button>
        </form>
      ) : null}
      <h3>Comments</h3>
      <ul data-testid="comments">{d.comments.map((m) => <li key={m.id}><strong>{m.author}</strong> <span className="muted small">{m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</span><p>{m.body}</p></li>)}</ul>
      <CommentForm busy={busy} onSend={(body) => act(() => api.commentApproval(c.id, body), "Comment added.")} />
    </section>
  );
}

function CommentForm({ busy, onSend }: { busy: boolean; onSend: (body: string) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) void onSend(body.trim()).then((ok) => { if (ok) setBody(""); }); }}>
      <label>Comment <textarea value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} data-testid="comment-body" /></label>
      <button type="submit" disabled={busy || !body.trim()} data-testid="comment-send">Add comment</button>
    </form>
  );
}
