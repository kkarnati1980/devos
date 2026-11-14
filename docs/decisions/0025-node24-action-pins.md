# 0025 — Node 24 setup actions, SHA-pinned (DEVOS-203)

- **Status:** accepted (runner B, 14 Nov 2026) · **Linear:** DEVOS-203 (split from DEVOS-197) · ADR-0013 (runner decides technical questions)

## Context
Every workflow uses `actions/checkout@v4`, `actions/setup-node@v4` and `pnpm/action-setup@v4`, which run on Node 20 (deprecated by GitHub) and are pinned by a moving tag, not a SHA (D7/D13).

## Decision
1. **Versions.** Move to the *first* Node 24 major of each action, pinned to the full commit SHA with the version as a comment. The first Node 24 major changes the least besides the runtime; later majors (checkout v6/v7, setup-node v6/v7, action-setup v6) add behaviour and, for `pnpm/action-setup@v6`, were under two weeks old.
   - `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` (v5.1.0, `using: node24`)
   - `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444` (v5.0.0, `using: 'node24'`)
   - `pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320` (v5.0.0; only change from v4 is `using: node24`)
   SHAs were read with `git ls-remote` and each tag's `action.yml` checked for `using: node24`.
2. **No change to what a job checks.** `setup-node@v5` turns on dependency caching by itself when `package.json` has a `packageManager` field (ours does). Every setup-node step that had no `cache:` input gets `package-manager-cache: false`, so it behaves exactly as v4 did (no cache; the gate jobs keep reading nothing from a cache).
3. **Split, because of the floor guard.** The full change gives 57 floor-guard hits, all KK-only:
   - `floor-guard.yml` is a guard path, so changing it with anything else makes every other file a `guard-change-not-isolated` hit. It goes in its own PR (Codex `FLOOR-GUARD CHANGE` marker).
   - `security.yml` hits name security scanning, so they are KK-only by design (spec §4.4). That PR goes to KK as a decision card, as DEVOS-203 asks.
   - The other 11 workflows still give KK-only `ci-step-changed` hits, for two technical reasons in the guard, not because the change is risky: the 40-character SHA pushes each step's hit text past the 200-character cut, and a cut text fails closed; and `ciBodyIsPlain` does not know the shaping keys `node-version-file`, `package-manager-cache`, `persist-credentials`, `ref`, `sparse-checkout` or a `uses:` ref with a version comment.
   So the order is: (a) a guard-only PR that keeps the full step body for `ci-step-*` hits and teaches `ciBodyIsPlain` those keys (follow-up issue under DEVOS-203); (b) this PR for the 11 workflows, cleared by Codex Keeps; (c) `floor-guard.yml` alone; (d) `security.yml` alone, with a KK card listing its hits on the exact SHA.

## Consequences
- Node 20 deprecation warnings stop once (b)–(d) have merged.
- dashboard-e2e keeps its pinned container image (DEVOS-100); only its setup actions move.
- `ubuntu-latest` becomes Ubuntu 26 (GitHub notice of 19 Oct 2026); no workflow pins the runner image, and none of these changes depends on it.
