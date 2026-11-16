"use client";
// M2.5-b3 (DEVOS-246, docs/modules/M2.5.md "M2.5-b3 decisions"): the project page's "Remove project" panel. It shows
// the teardown state, `purge_after` in IST, what DevOS still holds per provider and the last leftover check as text,
// and offers Archive (after a second, in-page confirmation), Restore and "Ask to delete now". There is no delete
// button: deleting for good only happens after KK approves the purge card in the Approvals inbox (decision 2).
// Escaped output only (strict nonce CSP); every POST carries the session's CSRF token (DevosApi adds it).
import { useCallback, useEffect, useRef, useState } from "react";
import { DevosApi, explain, type TeardownView } from "../../../../lib/api";
import { formatIst } from "../../../../lib/format";

const PROVIDER_NAMES: Record<string, string> = { github: "GitHub", coolify: "Coolify", vault: "Vault", backup: "Backups", r2: "R2", cloudflare: "Cloudflare" };
const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Plain words for the codes the teardown routes answer with; the code itself is shown too. */
export function removeError(code: string): string {
  switch (code) {
    case "project-not-found":
    case "project_not_found": return "DevOS has no record of this project on the server yet.";
    case "teardown-not-configured": return "Removing projects is not switched on on the server yet.";
    case "teardown-store-failed": return "The project's state could not be read. Try again in a minute.";
    case "archive-days-invalid": return "The archive period in Settings is not valid (1 to 365 days).";
    case "already_archived": return "This project is already archived.";
    case "not_archived": return "This project is not archived.";
    case "project-busy": return "DevOS is still working on this project (setting it up or deleting it). Try again in a few minutes.";
    case "policy_denied": return "A DevOS rule does not allow this.";
    case "approval_required": return "A DevOS rule asks for an approval before this can run.";
    case "ownership_mismatch": return "DevOS could not prove that it owns one of the project's resources, so it stopped.";
    case "provider_forbidden": return "A provider refused: the access key DevOS uses is missing a permission.";
    case "provider_error":
    case "delete_unconfirmed": return "A provider did not answer as expected. Try again in a few minutes.";
    case "unsupported_resource": return "The project has a kind of resource DevOS does not know how to handle yet.";
    case "purge-already-approved": return "You already approved deleting this project; DevOS will do it within a few minutes.";
    case "teardown-timeout": return "This is taking longer than expected; it carries on in the background. Reload this page in a minute.";
    case "api-unreachable": return "The DevOS API did not answer in time. If you pressed Archive or Restore, it may still be running: reload this page in a minute.";
    default: return explain(code);
  }
}

export function stateText(v: TeardownView): string {
  if (v.stage === "purged") return "Deleted for good.";
  if (v.stage !== "archived") return "Active. Archive stops its apps and makes the code read-only; nothing is deleted.";
  const since = v.archivedAt ? ` since ${formatIst(v.archivedAt)}` : "";
  const until = v.purgeAfter ? ` DevOS will ask you to delete it for good after ${formatIst(v.purgeAfter)}.` : "";
  return `Archived${since}: its apps are stopped and its code is read-only.${until}`;
}

export function countsText(active: Record<string, number>): string {
  const parts = Object.keys(active)
    .filter((p) => Number.isInteger(active[p]) && (active[p] ?? 0) > 0)
    .sort()
    .map((p) => `${providerName(p)}: ${active[p]}`);
  return parts.length ? parts.join(", ") : "nothing recorded";
}

export function RemovePanel({ apiOrigin, slug }: { apiOrigin: string; slug: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [view, setView] = useState<TeardownView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (live: () => boolean) => {
    const si = await api.connect();
    if (!live()) return;
    if (!si.ok) return setMsg(`${removeError(si.code)} (${si.code})`);
    const r = await api.teardown(slug);
    if (!live()) return;
    if (r.ok) { setView(r.data); setMsg(null); }
    else { setView(null); setMsg(`${removeError(r.code)} (${r.code})`); }
  }, [api, slug]);

  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => { live = false; };
  }, [load]);

  const run = async (op: () => Promise<{ ok: true } | { ok: false; code: string }>, done: string) => {
    setBusy(true);
    setConfirming(false);
    setNote(null);
    const r = await op();
    setBusy(false);
    setNote(r.ok ? done : `${removeError(r.code)} (${r.code})`);
    await load(() => true);
  };

  const archive = () => view && run(() => api.archiveProject(view.projectId), "Archived. Nothing was deleted; Restore brings it back.");
  const restore = () => view && run(() => api.restoreProject(view.projectId), "Restored. Its apps stay stopped until the next deploy starts them.");
  const askPurge = () => view && run(async () => {
    const r = await api.askPurge(view.projectId);
    return r.ok ? { ok: true as const } : r;
  }, "The delete card is in Approvals. Nothing is deleted until you approve it there.");

  const card = view?.purgeCardId && UUID.test(view.purgeCardId) ? view.purgeCardId : null;
  const archived = view?.stage === "archived";
  const active = view !== null && !archived && view.stage !== "purged";

  return (
    <section className="panel" aria-labelledby="remove-h" data-testid="remove-panel">
      <h2 id="remove-h">Remove project</h2>
      {msg ? <p className="muted" data-testid="remove-error">{msg}</p> : null}
      {!msg && !view ? <p className="muted">Loading…</p> : null}
      {view ? (
        <>
          <p data-testid="remove-state">{stateText(view)}</p>
          <dl className="facts">
            <dt>Still held</dt>
            <dd data-testid="remove-counts">{countsText(view.active)}</dd>
            <dt>Last leftover check</dt>
            <dd data-testid="remove-scan">
              {view.lastScan ? (
                <>
                  {formatIst(view.lastScan.scannedAt)}:{" "}
                  {view.lastScan.hits.length === 0 && view.lastScan.errors.length === 0 ? "nothing left." : null}
                  {view.lastScan.hits.length || view.lastScan.errors.length ? (
                    <ul className="list">
                      {view.lastScan.hits.map((h, k) => (
                        <li key={`h${k}`} data-testid="remove-scan-hit">
                          still there: {providerName(h.provider)} {h.kind} “{h.name}” <span className="muted small">({h.externalId})</span>
                        </li>
                      ))}
                      {view.lastScan.errors.map((e, k) => (
                        <li key={`e${k}`} data-testid="remove-scan-error">
                          could not check {e.scanner} <span className="muted small">({e.code})</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : "none yet"}
            </dd>
          </dl>
          {active && !confirming ? (
            <p>
              <button type="button" onClick={() => setConfirming(true)} disabled={busy} data-testid="remove-archive">Archive</button>
            </p>
          ) : null}
          {active && confirming ? (
            <p data-testid="remove-confirm">
              Archive {view.slug}? Its apps stop and its code becomes read-only. Nothing is deleted.{" "}
              <button type="button" onClick={() => void archive()} disabled={busy} data-testid="remove-archive-confirm">Yes, archive</button>{" "}
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} data-testid="remove-archive-cancel">Cancel</button>
            </p>
          ) : null}
          {archived ? (
            <p>
              <button type="button" onClick={() => void restore()} disabled={busy} data-testid="remove-restore">Restore</button>{" "}
              {card ? (
                <a href={`/approvals?id=${encodeURIComponent(card)}`} data-testid="remove-card-link">Open the delete card in Approvals</a>
              ) : view.purgeAskAvailable ? (
                <button type="button" onClick={() => void askPurge()} disabled={busy} data-testid="remove-ask-purge">Ask to delete now</button>
              ) : null}
            </p>
          ) : null}
          {busy ? <p className="muted" data-testid="remove-busy">Working… this can take up to two minutes.</p> : null}
        </>
      ) : null}
      {note ? <p className="muted" data-testid="remove-note">{note}</p> : null}
    </section>
  );
}
