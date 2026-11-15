// ADR-0012 CR-a2 (DEVOS-198): preflightOpen (AT3) and the decision log rows from KK's comment (AT4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingSecrets, preflightDecisions, preflightOpen, preflightSecretName, preflightView } from "../dist/preflight.js";

const P = "11111111-1111-4111-8111-111111111111";
// The shape @devos/analyst buildPreflight returns (its own AT1 pins the builder); fixed here so this file needs only
// the API's dist.
const items = [
  { id: "PF-1", kind: "decision", text: "Who pays for SMS messages?", default: "Architect decides" },
  { id: "PF-2", kind: "decision", text: "Monthly spend cap for this project", default: "USD 15 (the project's budget envelope)" },
  { id: "PF-3", kind: "decision", text: "Should the preview be reachable on a public URL?", options: ["no", "yes"], default: "no — tailnet only" },
  { id: "PF-4", kind: "secret", text: "SMS_API_KEY", default: "enter in setup wizard" },
];

function reader(state, list = items) {
  return { preflightSnapshot: async () => (state === null ? null : { state, items: list }) };
}
function vault(names) {
  const set = new Set(names);
  return { hasProject: async (pid, n) => pid === P && set.has(n) };
}

test("AT3 (CR-a2): open only when approved and every secret is in the project vault; backfilled projects are open", async () => {
  const all = vault([preflightSecretName("SMS_API_KEY")]);
  assert.equal(await preflightOpen(P, reader("pending"), all), false, "pending card");
  assert.equal(await preflightOpen(P, reader("approved"), vault([])), false, "approved, secret missing");
  assert.deepEqual(await missingSecrets(P, items, vault([])), ["SMS_API_KEY"]);
  assert.equal(await preflightOpen(P, reader("approved"), all), true, "approved and present");
  assert.deepEqual(await missingSecrets(P, items, all), []);
  assert.equal(await preflightOpen(P, reader("rejected"), all), false, "rejected");
  assert.equal(await preflightOpen(P, reader("approved", null), vault([])), true, "backfilled: approved, no pre-flight list");
  assert.equal(await preflightOpen(P, reader(null), all), false, "no such project");
  // Fail closed on any read error.
  const broken = { preflightSnapshot: async () => { throw new Error("db down"); } };
  assert.equal(await preflightOpen(P, broken, all), false);
  assert.equal(await preflightOpen(P, reader("approved"), { hasProject: async () => { throw new Error("vault down"); } }), false);
  // The vault name is the preview env's (M2.4 `<env>/<NAME>`); a global or other-env name does not count.
  assert.equal(await preflightOpen(P, reader("approved"), vault(["SMS_API_KEY", "live/SMS_API_KEY"])), false);
  // Codex PR122-r2: only the one-snapshot read decides. Separate state and list reads that would disagree (an
  // approved state next to a newer, unapproved version's list) are never consulted.
  const racy = {
    preflightState: async () => "approved",
    latestPreflight: async () => [],
    preflightSnapshot: async () => ({ state: "pending", items: [] }),
  };
  assert.equal(await preflightOpen(P, racy, all), false, "a new version reset the state in the same snapshot");
});

test("AT4 (CR-a2): `PF-1: yes` records PF-1 as kk and every other decision item as its default; secrets are never answered", () => {
  const rows = preflightDecisions(items, ["Looks good.\nPF-1: yes\nPF-4: MY_VALUE"]);
  const decisions = items.filter((i) => i.kind === "decision");
  assert.equal(rows.length, decisions.length, "one row per decision item, none for the secret");
  assert.deepEqual(rows[0], { itemId: "PF-1", text: items[0].text, answer: "yes", source: "kk" });
  // A blank line is no answer: the default stands, and it never overwrites an earlier real answer.
  for (const blank of ["PF-1: ", "PF-1:   ", "PF-1:\t", "PF-1:"]) assert.equal(preflightDecisions(items, [blank])[0].source, "default");
  assert.equal(preflightDecisions(items, ["PF-1: yes", "PF-1: "])[0].answer, "yes");
  for (const r of rows.slice(1)) {
    const it = items.find((i) => i.id === r.itemId);
    assert.equal(r.source, "default");
    assert.equal(r.answer, it.default);
  }
  assert.ok(!rows.some((r) => r.itemId === "PF-4"), "PF-4 is the secret item: its line is ignored");
  // The last line for an id wins; unknown ids and other text are ignored; long answers are cut to 1,000.
  const later = preflightDecisions(items, ["PF-1: no", " pf-2: x\nPF-99: z\nPF-2:  " + "y".repeat(1200) + "  ", "PF-1: yes after all"]);
  assert.equal(later[0].answer, "yes after all");
  assert.equal(later[1].source, "kk");
  assert.equal(later[1].answer.length, 1000);
  assert.equal(later.length, rows.length);
  assert.deepEqual(preflightDecisions(items, []).map((r) => r.source), decisions.map(() => "default"));
});

test("AT-CA3a (CR-a3): the pre-flight view shows state, the list, missing secret names and the decision log; reads only", async () => {
  const log = [{ itemId: "PF-1", answer: "yes", source: "kk", createdAt: "2026-11-14T10:00:00.000Z" }];
  const CARD = "33333333-3333-4333-8333-333333333333";
  const viewReader = (state, list = items, over = {}) => ({
    preflightSnapshot: async () => (state === null ? null : { state, items: list, approvalId: CARD }),
    projectBySlug: async (slug) => (slug === "shop" ? { id: P, continuousRun: true } : null),
    decisions: async (_pid, approvalId) => (approvalId === CARD ? log : [{ itemId: "PF-1", answer: "old version's answer", source: "kk", createdAt: "2026-11-13T10:00:00.000Z" }]),
    ...over,
  });
  assert.equal(await preflightView("nope", viewReader("pending"), vault([])), null, "unknown slug");
  const waiting = await preflightView("shop", viewReader("approved"), vault([]));
  assert.deepEqual(
    { state: waiting.state, open: waiting.open, missing: waiting.missingSecrets, unverified: waiting.secretsUnverified, n: waiting.items.length },
    { state: "approved", open: false, missing: ["SMS_API_KEY"], unverified: false, n: 4 },
    "approved, waiting for secrets",
  );
  assert.deepEqual(waiting.decisions, log);
  const open = await preflightView("shop", viewReader("approved"), vault([preflightSecretName("SMS_API_KEY")]));
  assert.equal(open.open, true);
  assert.deepEqual(open.missingSecrets, []);
  // No vault, or a vault that fails: every name is listed as missing, unverified, and the build stays closed.
  for (const v of [null, { hasProject: async () => { throw new Error("vault down"); } }]) {
    const u = await preflightView("shop", viewReader("approved"), v);
    assert.deepEqual([u.open, u.missingSecrets, u.secretsUnverified], [false, ["SMS_API_KEY"], true]);
  }
  // Outside the mode (backfilled): no list, open.
  const off = await preflightView("shop", viewReader("approved", null, { projectBySlug: async () => ({ id: P, continuousRun: false }) }), null);
  assert.deepEqual([off.continuousRun, off.items, off.open, off.secretsUnverified], [false, [], true, false]);
  // The view never carries a secret value: secret items are names only, and the vault is asked only `hasProject`.
  const asked = [];
  await preflightView("shop", viewReader("approved"), { hasProject: async (pid, n) => { asked.push(n); return false; }, reveal: async () => { throw new Error("must not reveal"); } });
  assert.ok(asked.every((n) => n === preflightSecretName("SMS_API_KEY")));
  // Codex PR127-r1: answers come only from the newest doc's card (PF numbers restart per version). An earlier
  // version's rows are never asked for; a doc with no card yet shows no answers and reads no log.
  const asks = [];
  const scoped = await preflightView("shop", viewReader("pending", items, { decisions: async (pid, a) => { asks.push(a); return a === CARD ? [] : log; } }), null);
  assert.deepEqual([scoped.decisions, asks], [[], [CARD]]);
  const noCard = await preflightView("shop", viewReader("pending", items, { preflightSnapshot: async () => ({ state: "pending", items, approvalId: null }), decisions: async () => { throw new Error("must not read"); } }), null);
  assert.deepEqual(noCard.decisions, []);
  // A store fault propagates (the route maps it to a fixed 500 code).
  await assert.rejects(preflightView("shop", viewReader("approved", items, { decisions: async () => { throw new Error("db"); } }), null));
});
