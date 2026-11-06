import { parseApiOrigin } from "../../lib/headers.mjs";
import { SettingsForm } from "./settings-form";

export default function SettingsPage() {
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <h1>Settings</h1>
      {apiOrigin ? (
        <SettingsForm apiOrigin={apiOrigin} />
      ) : (
        <p className="muted" data-testid="api-missing">The API address is not configured (DEVOS_API_ORIGIN).</p>
      )}
      <p className="muted small">Keys and tokens are replaced on the <a href="/setup">Setup</a> page. Project caps and lanes are edited per project once projects are live.</p>
    </>
  );
}
