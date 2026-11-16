// SM-18: one error type for the integration helpers. `code` is stable for callers; messages never carry a
// secret, a token or a signature.
export class IntegrationError extends Error {
  constructor(code, message) { super(message); this.name = "IntegrationError"; this.code = code; }
}
