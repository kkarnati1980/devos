// F1 Secret exposure: the environment is read here, on the server, once. The client only ever gets
// clientConfig(), built from an explicit allow-list; a secret-shaped name in that list stops start-up.
export const CLIENT_CONFIG_KEYS = [];   // e.g. ["PUBLIC_APP_NAME"]; never a secret
const SECRET_SHAPE = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i;

export function loadConfig(env = process.env, clientKeys = CLIENT_CONFIG_KEYS) {
  const bad = clientKeys.filter((k) => SECRET_SHAPE.test(k));
  if (bad.length) throw new Error(`config: secret-shaped key in CLIENT_CONFIG_KEYS: ${bad.join(", ")}`);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("config: PORT is not a valid port");
  const server = Object.freeze({ port, host: env.HOST || "0.0.0.0", sha: env.GIT_SHA || "unknown" });
  const client = Object.freeze(Object.fromEntries(clientKeys.filter((k) => env[k] !== undefined).map((k) => [k, String(env[k])])));
  return { server, clientConfig: () => client };
}
