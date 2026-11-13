// DEVOS-141: runs the floor-guard suite under `pnpm test` (root glob scripts/test/*.test.mjs).
// The suite lives beside the guard because its fixtures contain the very patterns the guard flags.
import "../floor-guard/test/guard.test.mjs";
