"use client";
// M2.6-b2b3 (DEVOS-248, docs/modules/M2.6.md "M2.6-b2b3 decisions"): "Open in Linear" links for the project and its
// modules. The API reads Linear by the stored ids only, so a module without a stored Linear id has no link. Every href
// is checked again here (https on linear.app only, else no link) and every text is escaped by React (strict nonce CSP).
import { useEffect, useRef, useState } from "react";
import { DevosApi, explain, type LinearLinksView } from "../../../lib/api";

/** Only an https URL on linear.app itself (no credentials, no port) becomes a link. */
export function linearHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "linear.app" && !u.port && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function linearError(code: string): string {
  switch (code) {
    case "project-not-found": return "DevOS has no record of this project on the server yet.";
    case "linear-unreachable": return "Linear did not answer. Try again in a minute.";
    case "linear-links-store-failed": return "The project's Linear ids could not be read. Try again in a minute.";
    default: return explain(code);
  }
}

export function LinearPanel({ apiOrigin, slug }: { apiOrigin: string; slug: string }) {
  const api = useRef(new DevosApi(apiOrigin)).current;
  const [view, setView] = useState<LinearLinksView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const si = await api.connect();
      if (!live) return;
      if (!si.ok) return setMsg(`${linearError(si.code)} (${si.code})`);
      const r = await api.linearLinks(slug);
      if (!live) return;
      if (r.ok) { setView(r.data); setMsg(null); }
      else { setView(null); setMsg(`${linearError(r.code)} (${r.code})`); }
    })();
    return () => { live = false; };
  }, [api, slug]);

  const project = view ? linearHref(view.project) : null;
  const modules = view ? view.modules.map((m) => ({ key: String(m.key), href: linearHref(m.url) })).filter((m) => m.href) : [];

  return (
    <section className="panel" aria-labelledby="linear-h" data-testid="linear-panel">
      <h2 id="linear-h">Linear</h2>
      {msg ? <p className="muted" data-testid="linear-error">{msg}</p> : null}
      {!msg && !view ? <p className="muted">Loading…</p> : null}
      {view && !view.enabled ? <p className="muted" data-testid="linear-off">The Linear mirror is switched off, so there are no Linear links.</p> : null}
      {view && view.enabled && !project && modules.length === 0 ? <p className="muted" data-testid="linear-none">This project is not in Linear yet.</p> : null}
      {project ? (
        <p><a href={project} rel="noreferrer noopener" target="_blank" data-testid="linear-project-link">Open the project in Linear</a></p>
      ) : null}
      {modules.length ? (
        <ul className="list" data-testid="linear-modules">
          {modules.map((m) => (
            <li key={m.key}>
              <a href={m.href!} rel="noreferrer noopener" target="_blank" data-testid="linear-module-link">Open {m.key} in Linear</a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
