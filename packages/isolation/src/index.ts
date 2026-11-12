export { IsolationError, type IsolationCode } from "./errors.js";
export { POOL, MAX_INDEX, SLUG, stackNetwork, indexFromPort, type StackEnv, type StackNetwork } from "./network.js";
export { hardenCompose, checkSettings, DEFAULT_LIMITS, MIN_LIMITS, type Limits, type LimitSettings } from "./compose.js";
export { isolationHook, type IsolationStore, type StackRecord, type HookProject, type HookEnv } from "./hook.js";
export { stateDocument, tailnetCidrOk, type StackState } from "./state.js";
