import { parseApiOrigin } from "../../lib/headers.mjs";
import { SetupWizard } from "./wizard";

export default function SetupPage() {
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <h1>Setup</h1>
      {apiOrigin ? (
        <SetupWizard apiOrigin={apiOrigin} />
      ) : (
        <p className="muted" data-testid="api-missing">The API address is not configured (DEVOS_API_ORIGIN).</p>
      )}
    </>
  );
}
