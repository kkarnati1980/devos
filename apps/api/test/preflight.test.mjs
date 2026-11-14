// ADR-0012 CR-a2 (DEVOS-198): preflightOpen (AT3) and the decision log rows from KK's comment (AT4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingSecrets, preflightDecisions, preflightOpen, preflightSecretName } from "../dist/preflight.js";

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
  return { preflightState: async () => state, latestPreflight: async () => list };
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
  const broken = { preflightState: async () => { throw new Error("db down"); }, latestPreflight: async () => items };
  assert.equal(await preflightOpen(P, broken, all), false);
  assert.equal(await preflightOpen(P, reader("approved"), { hasProject: async () => { throw new Error("vault down"); } }), false);
  // The vault name is the preview env's (M2.4 `<env>/<NAME>`); a global or other-env name does not count.
  assert.equal(await preflightOpen(P, reader("approved"), vault(["SMS_API_KEY", "live/SMS_API_KEY"])), false);
});

test("AT4 (CR-a2): `PF-1: yes` records PF-1 as kk and every other decision item as its default; secrets are never answered", () => {
  const rows = preflightDecisions(items, ["Looks good.\nPF-1: yes\nPF-4: MY_VALUE"]);
  const decisions = items.filter((i) => i.kind === "decision");
  assert.equal(rows.length, decisions.length, "one row per decision item, none for the secret");
  assert.deepEqual(rows[0], { itemId: "PF-1", text: items[0].text, answer: "yes", source: "kk" });
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
