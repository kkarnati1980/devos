import { parseApiOrigin } from "../../lib/headers.mjs";
import { ApprovalsPanel } from "./approvals-panel";

// M2.3-b2 (DEVOS-135): the approvals inbox. The card to open comes from `?id=` and is handled client-side.
export default function ApprovalsPage() {
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <h1>Approvals</h1>
      {apiOrigin ? (
        <ApprovalsPanel apiOrigin={apiOrigin} />
      ) : (
        <p className="muted" data-testid="api-missing">The API address is not configured (DEVOS_API_ORIGIN).</p>
      )}
    </>
  );
}
