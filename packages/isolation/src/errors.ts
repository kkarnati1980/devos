// S4-a error codes (docs/modules/S4.md). Messages name the service and the option, never a value from the
// Compose beyond that (an env value or a secret never reaches an error).
export type IsolationCode = "limits_missing" | "limits_over_budget" | "compose_unsafe" | "bad_stack";
export class IsolationError extends Error {
  constructor(readonly code: IsolationCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IsolationError";
  }
}
