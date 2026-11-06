import { getSource } from "../lib/source";
import { formatIst, formatUsd, label } from "../lib/format";
import { ReadinessPanel } from "./readiness-panel";

export default async function Home() {
  const projects = await getSource().listProjects();
  return (
    <>
      <h1>Projects</h1>
      <p className="muted" data-testid="project-count">{`${projects.length} projects`}</p>
      <ul className="grid" aria-label="Projects">
        {projects.map((p) => (
          <li key={p.slug} className="card" data-testid="project-card">
            <a className="card-title" href={`/projects/${encodeURIComponent(p.slug)}`}>{p.name}</a>
            <div className="row">
              <span className={`badge stage-${p.stage}`}>{label(p.stage)}</span>
              {p.pausedAt ? <span className="badge paused">paused</span> : null}
              {p.pendingApprovals > 0 ? <span className="badge warn">{p.pendingApprovals} to approve</span> : null}
            </div>
            <dl className="facts">
              <dt>Modules</dt><dd>{p.modulesMerged}/{p.modulesTotal} merged</dd>
              <dt>Spend</dt><dd>{formatUsd(p.spentUsd)} of {formatUsd(p.capUsd)}</dd>
              <dt>Lanes</dt><dd>{p.lanes}</dd>
              <dt>Updated</dt><dd>{formatIst(p.updatedAt)}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <ReadinessPanel scope="all projects" />
    </>
  );
}
