import { notFound } from "next/navigation";
import { getSource, isSlug } from "../../../lib/source";
import { formatIst, formatUsd, label, safeHttpUrl } from "../../../lib/format";
import { MODULE_STATUSES } from "../../../lib/types";
import { ReadinessPanel } from "../../readiness-panel";
import { parseApiOrigin } from "../../../lib/headers.mjs";
import { PreflightPanel } from "./preflight-panel";

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isSlug(slug)) notFound();
  const project = await getSource().getProject(slug);
  if (!project) notFound();
  const repo = safeHttpUrl(project.repoUrl);
  // ADR-0012 CR-a3: the pre-flight is read from the API client-side, with KK's session.
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <p><a href="/">← All projects</a></p>
      <h1 data-testid="project-name">{project.name}</h1>
      <div className="row">
        <span className={`badge stage-${project.stage}`}>{label(project.stage)}</span>
        {project.pausedAt ? <span className="badge paused">paused {formatIst(project.pausedAt)}</span> : null}
      </div>
      <dl className="facts">
        <dt>Spend</dt><dd>{formatUsd(project.spentUsd)} of {formatUsd(project.capUsd)}</dd>
        <dt>Lanes</dt><dd>{project.lanes}</dd>
        <dt>Repository</dt><dd>{repo ? <a href={repo} rel="noreferrer noopener">{repo}</a> : "—"}</dd>
      </dl>

      <section aria-labelledby="board-h">
        <h2 id="board-h">Module board</h2>
        <div className="board" data-testid="module-board">
          {MODULE_STATUSES.map((status) => {
            const cards = project.modules.filter((m) => m.status === status);
            return (
              <section key={status} className="column" aria-label={label(status)}>
                <h3>{label(status)} <span className="muted">({cards.length})</span></h3>
                <ul>
                  {cards.map((m) => (
                    <li key={m.key} className="mcard" data-testid="module-card">
                      <strong>{m.key}</strong> {m.title}
                      <div className="muted small">
                        Lane {m.lane}
                        {m.dependsOn.length ? ` · needs ${m.dependsOn.join(", ")}` : ""}
                        {m.mergedSha ? ` · ${m.mergedSha.slice(0, 7)}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="spec-h">
        <h2 id="spec-h">Spec</h2>
        <pre className="text" data-testid="spec-text">{project.specExcerpt}</pre>
      </section>

      <section aria-labelledby="sum-h">
        <h2 id="sum-h">Agent summaries</h2>
        <ul className="list">
          {project.agentSummaries.map((s, k) => (
            <li key={k} data-testid="agent-summary">
              <span className="muted small">{formatIst(s.occurredAt)} · {s.role} · {s.model}</span>
              <p>{s.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="log-h">
        <h2 id="log-h">Log</h2>
        <pre className="text log" data-testid="log">
          {project.log.map((l) => `${l.ts} ${l.level.toUpperCase()} ${l.text}`).join("\n")}
        </pre>
      </section>

      {apiOrigin ? <PreflightPanel apiOrigin={apiOrigin} slug={project.slug} /> : null}

      <ReadinessPanel scope={project.slug} />
    </>
  );
}
