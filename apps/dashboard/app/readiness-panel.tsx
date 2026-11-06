/** Placeholder for the readiness and standard-selection panel (filled by S7, DEVOS-68). */
export function ReadinessPanel({ scope }: { scope: string }) {
  return (
    <section className="panel" aria-labelledby="readiness-h" data-testid="readiness-panel">
      <h2 id="readiness-h">Readiness and standard selection</h2>
      <p className="muted">Not available yet for {scope}. The readiness gate (S7) fills this panel.</p>
    </section>
  );
}
