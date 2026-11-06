import { parseApiOrigin } from "../../lib/headers.mjs";
import { NotificationsPanel } from "./notifications-panel";

export default function NotificationsPage() {
  const apiOrigin = parseApiOrigin(process.env.DEVOS_API_ORIGIN);
  return (
    <>
      <h1>Notifications</h1>
      {apiOrigin ? (
        <NotificationsPanel apiOrigin={apiOrigin} />
      ) : (
        <p className="muted" data-testid="api-missing">The API address is not configured (DEVOS_API_ORIGIN).</p>
      )}
    </>
  );
}
