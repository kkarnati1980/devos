"use client";
// M1.6 notifications page: the dashboard feed, the three channels (on/off, bell URL, recipient) and
// "Send test card", which shows each channel's outcome. Escaped output only (no raw HTML).
import { useCallback, useEffect, useRef, useState } from "react";
import { DevosApi, explain, type ChannelKind, type ChannelView, type Delivery, type NoticeItem } from "../../lib/api";

const LABELS: Record<ChannelKind, string> = { dashboard: "Dashboard", mybrain: "MyBrain bell", email: "Email" };
const TARGET_LABELS: Partial<Record<ChannelKind, string>> = { mybrain: "Bell webhook URL (https)", email: "Send to address" };

function outcome(d: Delivery) {
  return d.status === "sent" ? "sent" : d.status === "failed" ? `failed (${d.error ?? "error"})` : "pending";
}

export function NotificationsPanel({ apiOrigin }: { apiOrigin: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [notices, setNotices] = useState<NoticeItem[] | null>(null);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [last, setLast] = useState<Delivery[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [f, c] = await Promise.all([api.notifications(), api.channels()]);
    if (!f.ok) return setMsg(`${explain(f.code)} (${f.code})`);
    if (!c.ok) return setMsg(`${explain(c.code)} (${c.code})`);
    setNotices(f.data.notices);
    setChannels(c.data.channels);
    setTargets(Object.fromEntries(c.data.channels.map((x) => [x.kind, x.target ?? ""])));
  }, [api]);

  useEffect(() => {
    (async () => {
      const si = await api.connect();
      if (!si.ok) return setMsg(`${explain(si.code)} (${si.code})`);
      await load();
    })();
  }, [api, load]);

  async function save(kind: ChannelKind, patch: { enabled?: boolean; target?: string | null }) {
    const r = await api.saveChannel(kind, patch);
    if (!r.ok) return setMsg(`${explain(r.code)} (${r.code})`);
    setMsg(`${LABELS[kind]} saved.`);
    await load();
  }

  async function sendTest() {
    setBusy(true);
    const r = await api.sendTest();
    setBusy(false);
    if (!r.ok) return setMsg(`${explain(r.code)} (${r.code})`);
    setLast(r.data.deliveries);
    setMsg("Test card sent.");
    await load();
  }

  if (!notices) return msg ? <p className="panel" role="alert">{msg}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      {msg ? <p className="panel" role="status" data-testid="notice">{msg}</p> : null}
      <section className="panel" data-testid="channels">
        <h2>Channels</h2>
        {channels.map((c) => (
          <div key={c.kind} className="form" data-testid={`channel-${c.kind}`}>
            <label>
              <input type="checkbox" checked={c.enabled} onChange={(e) => save(c.kind, { enabled: e.target.checked })} /> {LABELS[c.kind]}
              {c.configured ? null : <span className="muted small"> · not configured on the server</span>}
            </label>
            {TARGET_LABELS[c.kind] ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = (targets[c.kind] ?? "").trim();
                  save(c.kind, { target: t === "" ? null : t });
                }}
              >
                <label>
                  {TARGET_LABELS[c.kind]}
                  <input name={`target-${c.kind}`} value={targets[c.kind] ?? ""} onChange={(e) => setTargets({ ...targets, [c.kind]: e.target.value })} autoComplete="off" />
                </label>
                <button type="submit" data-testid={`save-${c.kind}`}>Save</button>
              </form>
            ) : null}
          </div>
        ))}
        <button type="button" onClick={sendTest} disabled={busy} data-testid="send-test">Send test card</button>
        {last ? (
          <ul data-testid="test-result">
            {last.map((d) => (
              <li key={d.channel}>{LABELS[d.channel]}: {outcome(d)}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="panel" data-testid="feed">
        <h2>Recent</h2>
        {notices.length === 0 ? <p className="muted">No notifications yet.</p> : null}
        <ul>
          {notices.map((n) => (
            <li key={n.id} id={n.id} data-testid="feed-item">
              <strong>{n.title}</strong> <span className="muted small">{n.kind} · {new Date(n.createdAt).toLocaleString()}</span>
              {n.body ? <p>{n.body}</p> : null}
              {n.reasons.length ? (
                <ul>
                  {n.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              ) : null}
              <p className="muted small">{n.deliveries.map((d) => `${LABELS[d.channel]}: ${outcome(d)}`).join(" · ")}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
