import { parseApiOrigin } from "../../lib/headers.mjs";
import { DeadLettersPanel } from "./dead-letters-panel";

export default function DeadLettersPage() {
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <h1>Failed runs</h1>
      {apiOrigin ? (
        <DeadLettersPanel apiOrigin={apiOrigin} />
      ) : (
        <p className="muted" data-testid="api-missing">The API address is not configured (DEVOS_API_ORIGIN).</p>
      )}
    </>
  );
}
