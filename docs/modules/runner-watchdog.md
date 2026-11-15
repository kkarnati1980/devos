# Runner watchdog (contract)

- **Linear:** DEVOS-217 · P2 (build-process support) · Lane C · High. Split into DEVOS-219 (core), DEVOS-220 (runtime wiring) and DEVOS-221 (server check), one PR each.
- **Source:** KK's decision, 15 Nov 2026 (20:45 IST), after two long silent stops: 13–14 Nov (Linear and Gmail down, about 18 h) and 14–15 Nov (every scheduled run refused at start while the account payment was fixed, about 21 h). A run that never starts cannot alert, so the check lives outside Claude, on the DevOS server.
- **Applies:** ADR-0011 (a timeout on every outbound call, retries only for reads, no secret in logs or email), F2 (server-side fetches only to the allow-listed Linear endpoint), M1.6 (notification channels), M2.6 (`LinearClient`), the server-agent contract (server checks), ADR-0013 (runner technical decisions recorded here).
- **Owned files:** `apps/api/src/runner-watchdog.ts`, `apps/api/test/runner-watchdog.test.mjs` (DEVOS-219); `apps/api/src/runner-watchdog-runtime.ts`, `apps/api/test/runner-watchdog-runtime.test.mjs`, the `RunnerWatchdogState` model in `packages/db/prisma/schema.prisma` and migration `20261115000100_runner_watchdog_state`, the wiring lines in `apps/api/src/main.ts`, `runtime.ts`, `routes.ts` (`/health`) and `openapi.yaml`, the `@devos/linear-sync` dependency in `apps/api/package.json` (+ lockfile) and its manifest line in `Dockerfile` (DEVOS-220); `scripts/server/checks/runner-watchdog.sh` and its test case in `scripts/test/server-agent.test.mjs` (DEVOS-221); this contract.

## Goal
Every 30 minutes, read the newest comment time on the two runner logs (DEVOS-75 for runner A, DEVOS-89 for runner B). When neither has had a comment for 2 hours, tell KK once, in plain language, through the existing M1.6 channels (email and the MyBrain bell), and tell him again when the runners are back. Tell him separately when the server itself cannot reach Linear for 2 hours. Stay quiet when the silence is the weekly cap.

## Runner decisions (ADR-0013)
1. **Where it runs: inside the DevOS API process, not a new systemd unit.** The issue asks to extend the server agent with a 30-minute timer. The server agent is bash with no vault, no `safeFetch`-style client and no M1.6 notifier; a new systemd unit would also need KK to run an installer. The API already has the vault (`linear_api_key`, H8), the M2.6 `LinearClient` (timeout, read-only retries, endpoint pinned to `https://api.linear.app/graphql`), the M1.6 `Notifier` (email + bell, secret-shaped text refused) and in-process timers (the analyst sweep, the requirements sync). It ships through the existing deploy-on-PASS, so KK runs nothing. The server agent's part is the heartbeat check (217c), so a dead API (and so a dead watchdog) is still visible from outside.
2. **Pure core, thin shell.** 217a is a pure function `step(observation, state, now) → { notices, state }` with no I/O, so every acceptance test runs on fixtures. 217b adds the Linear read, the notifier call, the stored state and the timer.
3. **State is stored (217b), not in memory,** so a redeploy inside a 6-hour window never repeats an alert.
4. **"Activity" is the newest comment `createdAt` on either issue,** by anyone. An edited old comment is not new activity.
5. **Cap pause:** when the newest comment across both issues is a `RUN END … idle: weekly cap reached` line, the silence is expected: a "paused by the weekly cap" note goes out at most once per 24 hours, and no silent alert. This holds only until the next weekly reset (Saturday 13:30 IST) plus 2 hours: runners still silent after that have stopped for another reason (for example, a payment problem), so the silent alert applies (pre-review finding 1).
6. **While Linear cannot be read,** no silence judgement is made (the times are unknown). After 2 hours of failed reads, the "Linear API unreachable from the server" alert goes out (6-hour limit). The first good read clears the failure clock, but not the last alert time, so flapping reads still get at most one alert per 6 hours (Codex PR136-r1).
7. **Recovery:** after a silent alert, the first observation with a comment newer than the silence start sends one "build runners active again" line and clears the alert state. A newer comment that is already 2 hours old when first seen (after a Linear outage) moves the silence forward instead, so the two notices never go out together (pre-review finding 2).

## Interface (217a)
```ts
type Observation =
  | { ok: true; newest: { at: string /* ISO UTC */; body: string } | null } // newest comment across DEVOS-75 and DEVOS-89
  | { ok: false };                                                       // the Linear read failed
interface WatchdogState {
  silentAlertAt: string | null;   // last silent alert sent
  silentSince: string | null;     // the activity time that alert reported; set while an alert is open
  capNoteAt: string | null;       // last "paused by the weekly cap" note
  linearFailingSince: string | null;
  linearAlertAt: string | null;
  lastRunAt: string | null;       // heartbeat (217b exposes it, 217c checks it)
}
function step(obs: Observation, state: WatchdogState, nowMs: number): { notices: NoticeInput[]; state: WatchdogState };
function formatIst(iso: string): string; // "20:45 IST, 15 Nov 2026"
```
Constants: `SILENT_MS = 2 h`, `REPEAT_MS = 6 h`, `CAP_NOTE_MS = 24 h`, `LINEAR_DOWN_MS = 2 h`, `TICK_MS = 30 min`.

## Behaviour
1. **Silent alert:** `now − newest.at ≥ 2 h`, the newest comment is not a cap idle, and no silent alert in the last 6 hours → one notice, kind `info`, title `[DevOS] Build runners silent since <IST time>`, body: the last activity time in IST, then "Check claude.ai: Settings → Billing (payment and plan active) and Settings → Connectors (Linear connected). Then reply to Claude in the AI Development Team chat." `silentSince` keeps the reported time. With no comment at all, nothing is judged (a fresh install).
2. **Repeat:** while still silent, at most one silent alert per 6 hours.
3. **Cap pause:** see decision 5; title `[DevOS] Build runners paused by the weekly cap`.
4. **Recovery:** see decision 7; title `[DevOS] Build runners active again`, body with the new activity time in IST.
5. **Linear unreachable:** see decision 6; title `[DevOS] Linear API unreachable from the server`, body with the failure start in IST and "the build runners' status cannot be read; nothing is needed from you unless this lasts".
6. **Notices only through M1.6** (`Notifier.notify`), so `parseNotice` limits (title ≤ 120, body ≤ 2000, secret-shaped text refused) apply. The watchdog never writes to Linear.
7. **No secret in logs or notices:** the watchdog logs fixed codes and times only; a comment body is read only to test the cap-idle prefix and is never copied into a notice or a log.
8. **Timeouts and retries (217b):** the Linear read uses `LinearClient.query` (timeout, retries for reads only); the key is read from the vault by name at call time.

## Not in scope
- Alerting through Gmail from a runner (the runners' own STUCK ALERT stays as it is).
- Any Linear write, and any change to the server agent's deploy flow.

## Acceptance tests
<!-- Fixture rule (docs/decisions/0024-local-secret-scan.md): fake, low-entropy test values only. -->
| # | Pass when |
|---|---|
| AT1 | With a newest comment 2 h 05 m old, exactly one silent alert is produced; a second step 30 minutes later produces none (6-hour limit) |
| AT2 | With a newest comment 1 h 50 m old, no notice is produced |
| AT3 | With a newest comment that is a weekly-cap idle RUN END, one "paused by the weekly cap" note is produced, not a silent alert, and no second note within 24 hours; 2 hours after the next weekly reset, a silent alert is produced instead |
| AT4 | When every Linear read fails for 2 hours, the "Linear API unreachable" alert is produced once (6-hour limit); before 2 hours, none |
| AT5 | After a silent alert, a newer comment produces exactly one "active again" notice, and a later silence alerts again |
| AT6 | No secret appears in a notice or a log: a comment body holding a fake key never reaches a notice, and the 217b log scan finds no key-shaped text |
| AT7 | (217c) The `runner-watchdog` server check passes when the watchdog's last run is under 35 minutes old, fails when older or missing, and skips when DevOS is not deployed |

## Pass rule
- `pnpm --filter @devos/api test` exits 0 on the merged SHA, covering AT1–AT6 in `apps/api/test/runner-watchdog.test.mjs` (DEVOS-219) and `apps/api/test/runner-watchdog-runtime.test.mjs` (DEVOS-220).
- `node --test scripts/test/server-agent.test.mjs` exits 0 on the merged SHA, covering AT7 (217c) and the server agent's existing tests.
- After deploy, the `server-check` status on the live SHA includes `runner-watchdog` passed, with a last run under 35 minutes old.

## Merge gate
CI green and Codex PASS on the exact head SHA (D1).

## Changelog
- **v0.1.0 (15 Nov 2026, runner B):** contract, decisions and split.

## Build record
- 15 Nov 2026, runner B: contract written; DEVOS-219 built first. Pre-review: 3 findings, 2 fixed (cap pause ends at the weekly reset; no recovery and silent alert in one step). Not fixed (low): a newer cap-idle line after a silent alert counts as recovery, because a run did start, so the account and connectors work again. Second round PASS, with 2 low findings recorded, not fixed: a wrong cap line posted just after a reset holds alerts for up to a week (runners post a cap idle only when the ledger is over the cap, so this needs a runner bug); and the cap note's "resume at the reset" wording can be up to 2 hours stale. Fixed: the stale doc comment on `step`.
- 15 Nov 2026, runner B (DEVOS-220): `@devos/linear-sync` is imported at run time like `@devos/db`, so the api scripts stay unchanged (the floor guard reads any change to them as KK-only; see S4.md, 15 Nov). The Linear read asks for the 50 newest comments per log and takes the newest by `createdAt` itself, whatever order Linear returns. A notice the notifier cannot send leaves the state unsaved, so the next tick sends it again (at least once). The heartbeat is `watchdog.lastRunAt` in `/health`. A Linear client that cannot be loaded turns the watchdog off with a logged code; it never stops the API. Pre-review: 5 findings (all low), 3 fixed (that load guard, a fixed set of logged notifier codes, a stale contract reference). Kept: the newest-first order is not assumed, because the newest comment is taken by time from the 50 read, and Linear returns comments newest first (the runner logs read through the Linear connector come back that way; checked again in DEVOS-221's live heartbeat). Also kept: the watchdog runs whenever the vault exists, so a missing Linear key shows up after 2 hours as the 'Linear API unreachable' alert, which points to the setup wizard.
- 15 Nov 2026, runner B: Codex PR136-r1 (1 medium, accepted): a good read cleared the last Linear alert time, so flapping reads could alert every 3 hours. It is now kept; an AT4 test runs a flapping sequence (14/14).
