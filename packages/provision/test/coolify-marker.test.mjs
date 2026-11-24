// DEVOS-21 part 6 (docs/modules/M2.4.md): Coolify refuses a description holding ':' (cycle 10,
// `http-422:description`), so Coolify descriptions carry `devos-owner-<id>`; `devos:<id>` from before is still read.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allowAll, CoolifyClient, MemoryStore, coolifyProjectStep, coolifyProjectOps, coolifyScanner, runProvision,
  ownershipMarker, coolifyOwnershipMarker, hasOwnershipMarker, describedPublicKey,
} from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "cf_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme app" };
const OTHER = "99999999-2222-4333-8444-555555555555";
const noSleep = async () => {};
const cfOf = (fake) => new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });

test("part 6: the two marker forms; the Coolify form has no colon; both are read, another project's never", () => {
  assert.equal(ownershipMarker(P.id), `devos:${P.id}`, "GitHub keeps the old form");
  assert.equal(coolifyOwnershipMarker(P.id), `devos-owner-${P.id}`);
  assert.match(coolifyOwnershipMarker(P.id), /^[A-Za-z0-9-]+$/);
  assert.ok(hasOwnershipMarker(`DevOS project acme devos:${P.id}`, P.id));
  assert.ok(hasOwnershipMarker(`DevOS project acme devos-owner-${P.id}`, P.id));
  assert.ok(hasOwnershipMarker(`devos-owner-${P.id}`, P.id), "the marker alone");
  assert.ok(hasOwnershipMarker(`DevOS deploy key acme devos-owner-${P.id} pub ssh-ed25519 AAAA`, P.id), "a marker followed by more words");
  assert.ok(hasOwnershipMarker(`x\tdevos:${P.id}\n`, P.id), "any whitespace delimits");
  const lookalikes = [
    `devos-owner-${P.id}-backup`, `xdevos-owner-${P.id}`, `devos-owner-${P.id}x`, `devos-owner-${P.id}.`, `(devos-owner-${P.id})`,
    `devos:${P.id}-backup`, `xdevos:${P.id}`, `devos:${P.id}:`, `devos-owner-${P.id.slice(0, -1)}`, `devos:${P.id.slice(0, -1)}`,
  ];
  // Codex PR230-r1: adjacent characters make a lookalike, never our marker.
  for (const d of lookalikes) assert.equal(hasOwnershipMarker(`DevOS project acme ${d}`, P.id), false, d);
  for (const d of [null, undefined, "", `devos:${OTHER}`, `devos-owner-${OTHER}`, `devos ${P.id}`]) assert.equal(hasOwnershipMarker(d, P.id), false, String(d));
});

test("part 6: a fresh Coolify project is created with the colon-free marker and recorded as owned", async () => {
  const fake = fakeProviders();
  const store = new MemoryStore();
  const out = await runProvision(P.id, [coolifyProjectStep(cfOf(fake), P)], { store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["created"]);
  const [proj] = [...fake.projects.values()];
  assert.equal(proj.description, `DevOS project acme devos-owner-${P.id}`);
  assert.ok(!proj.description.includes(":"));
});

test("part 6: a project marked the old way before part 6 is adopted, not duplicated; teardown and the scan still own it", async () => {
  const fake = fakeProviders();
  fake.projects.set("cfold00001", { uuid: "cfold00001", name: "devos-acme", description: `DevOS project acme devos:${P.id}`, environments: ["production"] });
  fake.projects.set("cfnew00001", { uuid: "cfnew00001", name: "devos-other", description: `DevOS project other devos-owner-${P.id}`, environments: ["production"] });
  fake.projects.set("cfnot00001", { uuid: "cfnot00001", name: "unrelated", description: `devos-owner-${OTHER}`, environments: ["production"] });
  fake.projects.set("cflook0001", { uuid: "cflook0001", name: "lookalike", description: `devos-owner-${P.id}-backup`, environments: ["production"] });
  const cf = cfOf(fake);
  const store = new MemoryStore();
  const out = await runProvision(P.id, [coolifyProjectStep(cf, P)], { store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["adopted"]);
  assert.equal(fake.creates().length, 0, "no second project");
  const ops = coolifyProjectOps(cf, P.id);
  assert.deepEqual(await ops.inspect({ externalId: "cfold00001" }), { owned: true });
  assert.deepEqual(await ops.inspect({ externalId: "cfnew00001" }), { owned: true });
  assert.deepEqual(await ops.inspect({ externalId: "cfnot00001" }), { owned: false });
  assert.deepEqual(await ops.inspect({ externalId: "cflook0001" }), { owned: false }, "Codex PR230-r1: a lookalike is not ours");
  const hits = await coolifyScanner(cf).scan({ id: P.id, slug: "acme" });
  assert.deepEqual(hits.filter((h) => h.kind === "project").map((h) => h.externalId).sort(), ["cfnew00001", "cfold00001"]);
});

test("part 6: the deploy key's public key is read from both description forms", () => {
  const pub = `ssh-ed25519 ${"A".repeat(68)}`;
  assert.equal(describedPublicKey(`DevOS deploy key acme devos-owner-${P.id} pub ${pub}`), pub);
  assert.equal(describedPublicKey(`DevOS deploy key acme devos:${P.id} pub:${pub}`), pub);
  assert.equal(describedPublicKey(`DevOS deploy key acme devos-owner-${P.id} pubx ${pub}`), null);
});
