# DevOS build standard — index

<!-- Generated from build-standard.yaml by `pnpm gen:standard`. Do not edit by hand. -->

Catalogue v1.0.0 (ADR-0010). This index is the only standard text the selector reads in full;
a module's full text (`modules/<id>.md`) is loaded only once that module is selected for a project.

## Floor — always on, every app (blocks preview and live)
| ID | Module | Enforces |
|---|---|---|
| F1 | Secret exposure | No secret ever leaves the server side of an app. |
| F2 | Internal-URL block | Server-side code cannot be used to reach DevOS, the host, the tailnet or cloud metadata. |
| F3 | Network and resource isolation | A project container cannot reach anything it was not given, and cannot starve the server. |

## Selectable — chosen per app (Lite or Full)
| ID | Module | Select when | Lite | Full adds |
|---|---|---|---|---|
| SM-01 | API input and contracts | The app has an API or forms. | Schema validation on every input; invalid input returns 4xx and never reaches the database | + contract tests generated from the API schema when frontend and backend are separate |
| SM-02 | Access control | Always, unless the app is a static page. | Deny by default; only /health and /ready are open; callers are KK's tailnet identity or a service token; no IDOR on routes that take an ID | + an app with its own login has sessions of 12 h at most, rotated at sign-in and revocable; an app with more than one user has row-level security or tenant scoping and two-user IDOR tests |
| SM-03 | Browser safety | The app has a web UI. | CSRF protection on state-changing routes; escaped output; no raw-HTML sinks | + a strict CSP, the full security-header set and a seeded-XSS E2E test |
| SM-04 | Outbound resilience | The app calls any external service. | A timeout on every outbound call | + retries only for safe operations, with exponential backoff, jitter, a cap and a maximum attempt count |
| SM-05 | Background work | Any task over about 2 s, or scheduled work. | A queue with a retry policy and a visible, retryable dead-letter queue | + for heavy compute a concurrency limit and a load check that keeps DevOS headroom (DV-NFR-10) |
| SM-06 | Data layer | The app stores data. | Transactions for related writes; indexes on foreign keys and filtered columns; a per-project pool limit; backward-compatible migrations only | + query-count (N+1) tests on list endpoints and concurrency tests on colliding writes |
| SM-07 | Idempotency | The app creates records or triggers effects that must not repeat. | An idempotency key on create endpoints and job handlers | + double-submit and replay tests |
| SM-08 | Data retention | The app stores personal or growing data. | A retention period per data class, plus a purge job | + a purge test, and the project's data included in the weekly test-restore |
| SM-09 | Ops and observability | The app runs as a service (nearly always). | /health and /ready; JSON logs with a request ID; error monitoring wired | + alert rules, a health-gated rollout and a rollback test across one migration |
| SM-10 | Feature flags | The app has user-visible features across spec phases. | One kill switch per spec phase, working without a redeploy | + a flag per feature, each toggled in a test |
| SM-11 | UI quality | The app has a web UI KK uses. | E2E for the main journey at desktop (1440×900) and phone (390×844) widths | + every journey; axe with no serious or critical issues; the main journey works by keyboard alone |
| SM-12 | Cost and rate | The app starts paid or heavy work. | Paid services declared with a monthly cap; usage metered to the project budget | + per-caller rate limits on paid or heavy endpoints |
| SM-13 | MyBrain integration | The app is opened from MyBrain (expected for every app). | Link-out profile: frame-ancestors 'none', no CORS, KK's Tailscale identity is the login, no MyBrain tokens in the app | + the embed or API mode KK picked on a card. Embed: frame-ancestors is MyBrain's exact origin, HTTPS both sides, origin-checked postMessage, CSRF inside the frame. API: per-app service token (vault, 90-day rotation), HMAC-signed requests with a timestamp, no CORS, tailnet ACL for that port only |
| SM-14 | Dependencies | The app uses third-party packages (nearly always). | A lockfile; no high or critical vulnerabilities | + a licence report; copyleft that would bind KK's project goes to a card first (D13) |
| SM-15 | User-supplied URL fetching | The app fetches URLs a user provides (the pilot does). | The full SSRF corpus on top of F2 (DNS rebinding, redirects to internal, IPv6 and encoded IPs, file:// and gopher://); response size and time caps | + per-domain rate limits for the platforms fetched |
| SM-16 | AI on untrusted content | An LLM processes content from users or the web. | Content delimited and treated as data; no side-effect tools unless allow-listed; model output never executed or rendered as raw HTML | + an injection test corpus and a per-request token cap |
| SM-17 | Files and uploads | The app accepts uploads or serves stored files. | Magic-byte type check; size cap; storage outside the web root under random names | + archive-bomb limits and signed download URLs that expire in 15 minutes or less |
| SM-18 | Integrations | The app takes payments, receives webhooks, caches data, or stores third-party tokens. | Only the sub-parts that apply: webhook HMAC with timestamp and replay protection; payment event dedupe and out-of-order handling; cache TTL with invalidation on write; third-party tokens encrypted with least scope | + replay, out-of-order and stale-read tests |

## Opt-in — only when KK asks on a card
| ID | Module |
|---|---|
| SM-C1 | Load testing at public scale |
| SM-C2 | Multi-region disaster recovery |
| SM-C3 | Public URL |
