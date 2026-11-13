// M2.4-c2c1 acceptance tests on fake GitHub + Coolify (docs/modules/M2.4.md, "M2.4-c2c split and c2c1 build notes").
import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  allowAll, CoolifyClient, GitHubClient, MemoryStore, coolifyProjectStep, githubRepoStep, deployKeySteps, runProvision, StepError,
  generateDeployKeyPair, normalisePublicKey, describedPublicKey, coolifyPrivateKeyOps, githubDeployKeyOps, deployKeyName,
} from "../dist/index.js";
import { fakeProviders } from "./fakes.mjs";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme", name: "Acme" };
const OWNER = "kkarnati1980";
const noSleep = async () => {};

async function setup({ fake = fakeProviders(), store = new MemoryStore() } = {}) {
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  const base = [githubRepoStep(gh, P, OWNER), coolifyProjectStep(cf, P)];
  await runProvision(P.id, base, { store, authorize: allowAll });
  const steps = () => [...base, ...deployKeySteps(gh, cf, store, P, OWNER)];
  const run = (authorize = allowAll) => runProvision(P.id, steps(), { store, authorize });
  return { fake, store, gh, cf, steps, run };
}

const keyPosts = (fake) => fake.creates().filter((c) => c.path === "/api/v1/security/keys");
const ghKeyPosts = (fake) => fake.creates().filter((c) => c.method === "POST" && /\/keys$/.test(c.path) && c.origin === "https://api.github.com");
const coolifyKey = (fake) => [...fake.keys.values()][0];
const ghKeys = (fake) => fake.deployKeys.get(`${OWNER}/devos-${P.slug}`) ?? [];

/** Decodes an unencrypted OpenSSH ed25519 private key and returns its public key line (independent of the encoder). */
function publicFromOpenSsh(pem) {
  const b = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  let o = 0;
  const str = () => { const n = b.readUInt32BE(o); o += 4; const v = b.subarray(o, o + n); o += n; return v; };
  assert.equal(b.subarray(0, 15).toString("latin1"), "openssh-key-v1\0"); o = 15;
  assert.equal(str().toString(), "none"); assert.equal(str().toString(), "none"); str();
  assert.equal(b.readUInt32BE(o), 1); o += 4;
  const pubBlob = str();
  const priv = str(); let q = 0;
  const pstr = () => { const n = priv.readUInt32BE(q); q += 4; const v = priv.subarray(q, q + n); q += n; return v; };
  assert.equal(priv.readUInt32BE(0), priv.readUInt32BE(4), "check ints match"); q = 8;
  assert.equal(pstr().toString(), "ssh-ed25519");
  const pub = pstr(); const sk = pstr();
  assert.equal(priv.length % 8, 0);
  // Derive the public key from the seed with Node's own ed25519 and compare.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sk.subarray(0, 32)]);
  const derived = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
  assert.equal(Buffer.from(derived, "base64url").toString("hex"), pub.toString("hex"));
  assert.deepEqual(sk.subarray(32), pub);
  return `ssh-ed25519 ${pubBlob.toString("base64")}`;
}

test("key pair: a valid OpenSSH ed25519 private key whose public half is the published one; fresh each time", () => {
  const a = generateDeployKeyPair("devos-acme-deploy");
  const b = generateDeployKeyPair("devos-acme-deploy");
  assert.match(a.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]{68}$/);
  assert.equal(publicFromOpenSsh(a.privateKey), a.publicKey);
  assert.notEqual(a.publicKey, b.publicKey);
  assert.equal(normalisePublicKey(`${a.publicKey} comment here`), a.publicKey);
  assert.equal(normalisePublicKey("ssh-rsa AAAA"), null);
});

test("AT1 fresh: one Coolify private key and one read-only GitHub deploy key that match; both in the inventory", async () => {
  const s = await setup();
  const out = await s.run();
  assert.deepEqual(out.slice(-2).map((o) => o.outcome), ["created", "created"]);
  const posts = keyPosts(s.fake);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.name, deployKeyName(P.slug));
  assert.ok(posts[0].body.description.includes(`devos:${P.id}`));
  const pub = describedPublicKey(posts[0].body.description);
  assert.equal(publicFromOpenSsh(posts[0].body.private_key), pub, "Coolify holds the private half of the described key");
  const gk = ghKeys(s.fake);
  assert.equal(gk.length, 1);
  assert.deepEqual([gk[0].title, gk[0].key, gk[0].read_only], [deployKeyName(P.slug), pub, true]);
  const inv = s.store.resources.filter((r) => r.kind === "private_key" || r.kind === "deploy_key");
  assert.deepEqual(inv.map((r) => [r.provider, r.kind, r.externalId]),
    [["coolify", "private_key", coolifyKey(s.fake).uuid], ["github", "deploy_key", `${OWNER}/devos-${P.slug}#${gk[0].id}`]]);
});

test("F1: the private key appears only in the one Coolify create body: no other request, journal row, inventory, error or output", async () => {
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, sw: process.stdout.write, ew: process.stderr.write };
  const cap = (...a) => { out.push(a.map(String).join(" ")); };
  console.log = console.error = console.warn = cap;
  process.stdout.write = (c, ...r) => { out.push(String(c)); return orig.sw.call(process.stdout, c, ...r); };
  process.stderr.write = (c, ...r) => { out.push(String(c)); return orig.ew.call(process.stderr, c, ...r); };
  let s;
  try {
    s = await setup();
    s.fake.faults.push({ match: (m, p) => m === "POST" && /\/repos\/.+\/keys$/.test(p), action: { status: 500 } });
    await assert.rejects(s.run(), (e) => { out.push(String(e.message), String(e.stack)); return e instanceof StepError; });
    await s.run();
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn });
    process.stdout.write = orig.sw; process.stderr.write = orig.ew;
  }
  const secret = coolifyKey(s.fake).private_key;
  const body = secret.split("\n")[1];
  const haystacks = [
    ...s.fake.calls.filter((c) => !(c.method === "POST" && c.path === "/api/v1/security/keys")).map((c) => JSON.stringify(c)),
    ...[...s.store.steps.values()].map((r) => JSON.stringify(r)),
    JSON.stringify(s.store.resources), ...out,
  ];
  for (const h of haystacks) assert.ok(!h.includes(body), "private key material leaked");
  assert.equal(keyPosts(s.fake).length, 1);
});

test("AT2 re-run creates nothing; a lost journal adopts both halves without a new key", async () => {
  const s = await setup();
  await s.run();
  const before = s.fake.creates().length;
  const again = await s.run();
  assert.deepEqual(again.slice(-2).map((o) => o.outcome), ["recorded", "recorded"]);
  s.store.steps.clear();
  const lost = await s.run();
  assert.deepEqual(lost.slice(-2).map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(s.fake.creates().length, before);
  assert.equal(s.fake.keys.size, 1);
  assert.equal(ghKeys(s.fake).length, 1);
});

test("AT3 crash after each create returns, before the DB write: the re-run adopts; one key of each kind", async () => {
  for (const kind of ["private_key", "deploy_key"]) {
    const s = await setup();
    const orig = s.store.recordResource.bind(s.store);
    let crash = true;
    s.store.recordResource = async (pid, r) => { if (crash && r.kind === kind) { crash = false; throw new Error("killed"); } return orig(pid, r); };
    await assert.rejects(s.run(), /killed/);
    const out = await s.run();
    assert.equal(out.find((o) => o.key === (kind === "private_key" ? "coolify/deploy_key" : "github/deploy_key")).outcome, "adopted");
    assert.equal(keyPosts(s.fake).length, 1);
    assert.equal(ghKeyPosts(s.fake).length, 1);
  }
});

test("AT4 a create that times out after it happened is adopted with one POST (each half)", async () => {
  const s = await setup();
  s.fake.faults.push({ match: (m, p) => m === "POST" && p === "/api/v1/security/keys", action: "timeout-after" });
  s.fake.faults.push({ match: (m, p) => m === "POST" && /\/repos\/.+\/keys$/.test(p), action: "timeout-after" });
  const out = await s.run();
  assert.deepEqual(out.slice(-2).map((o) => o.outcome), ["adopted", "adopted"]);
  assert.equal(keyPosts(s.fake).length, 1);
  assert.equal(ghKeyPosts(s.fake).length, 1);
});

test("a Coolify create that is not listed yet is create_unconfirmed (retryable), and the next run adopts it", async () => {
  const s = await setup();
  let hide = 2; // the read-back after the POST and the runner's second lookup
  const f = s.fake.fetchImpl;
  const hidden = async (url, init = {}) => {
    const r = await f(url, init);
    if ((init.method ?? "GET") === "GET" && new URL(url).pathname === "/api/v1/security/keys" && s.fake.keys.size && hide > 0) { hide--; return new Response("[]", { status: 200 }); }
    return r;
  };
  const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: hidden, sleep: noSleep });
  const steps = [...deployKeySteps(s.gh, cf, s.store, P, OWNER)];
  await assert.rejects(runProvision(P.id, steps, { store: s.store, authorize: allowAll }), (e) => e.code === "create_unconfirmed" && e.retryable);
  const out = await runProvision(P.id, steps, { store: s.store, authorize: allowAll });
  assert.deepEqual(out.map((o) => o.outcome), ["adopted", "created"]);
  assert.equal(keyPosts(s.fake).length, 1);
});

test("conflicts: a foreign Coolify key with our name, or a same-titled GitHub key that differs or can write → name_conflict, nothing created", async () => {
  {
    const s = await setup();
    s.fake.keys.set("pkforeign", { uuid: "pkforeign", name: deployKeyName(P.slug), description: "someone else's", private_key: "x" });
    await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "name_conflict" && !e.retryable);
    assert.equal(keyPosts(s.fake).length, 0);
  }
  for (const variant of ["other-key", "writable"]) {
    const s = await setup();
    const [cfStep] = deployKeySteps(s.gh, s.cf, s.store, P, OWNER);
    await runProvision(P.id, [cfStep], { store: s.store, authorize: allowAll });
    const pub = describedPublicKey(coolifyKey(s.fake).description);
    const key = variant === "other-key" ? generateDeployKeyPair("x").publicKey : pub;
    s.fake.deployKeys.set(`${OWNER}/devos-${P.slug}`, [{ id: 77, title: deployKeyName(P.slug), key, read_only: variant !== "writable" }]);
    await assert.rejects(s.run(), (e) => e instanceof StepError && e.code === "name_conflict" && e.step === "github/deploy_key");
    assert.equal(ghKeyPosts(s.fake).length, 0);
  }
});

test("fail closed: no Coolify half, two owned Coolify keys, or inconclusive lists create nothing", async () => {
  {
    const s = await setup();
    const [, ghStep] = deployKeySteps(s.gh, s.cf, s.store, P, OWNER);
    await assert.rejects(runProvision(P.id, [ghStep], { store: s.store, authorize: allowAll }));
    assert.equal(ghKeyPosts(s.fake).length, 0);
  }
  {
    const s = await setup();
    await s.run();
    const k = coolifyKey(s.fake);
    s.fake.keys.set("pkdup", { ...k, uuid: "pkdup" });
    s.store.steps.clear();
    const before = s.fake.creates().length;
    await assert.rejects(s.run(), (e) => e.code === "provider_error" && e.step === "coolify/deploy_key");
    assert.equal(s.fake.creates().length, before);
  }
  const shapes = [
    { path: "/api/v1/security/keys", body: { data: [] } },
    { path: "/api/v1/security/keys", body: [{ uuid: 5, name: "x" }] },
    { path: "/api/v1/security/keys", body: [{ uuid: "ok", name: "x", description: 3 }] },
    { path: /\/repos\/.+\/keys$/, body: [{ id: "1", title: "t", key: "k", read_only: true }] },
    { path: /\/repos\/.+\/keys$/, body: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `t${i}`, key: "k", read_only: true })) },
  ];
  for (const sh of shapes) {
    const s = await setup();
    if (typeof sh.path !== "string") {
      const [cfStep] = deployKeySteps(s.gh, s.cf, s.store, P, OWNER);
      await runProvision(P.id, [cfStep], { store: s.store, authorize: allowAll });
    }
    const f = s.fake.fetchImpl;
    const odd = async (url, init = {}) => {
      const p = new URL(url).pathname;
      const hit = typeof sh.path === "string" ? p === sh.path : sh.path.test(p);
      if ((init.method ?? "GET") === "GET" && hit) return new Response(JSON.stringify(sh.body), { status: 200 });
      return f(url, init);
    };
    const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: odd, sleep: noSleep });
    const cf = new CoolifyClient({ origin: "http://coolify.test:8000", token: () => TOKEN, fetchImpl: odd, sleep: noSleep });
    const before = s.fake.creates().length;
    await assert.rejects(runProvision(P.id, deployKeySteps(gh, cf, s.store, P, OWNER), { store: s.store, authorize: allowAll }),
      (e) => e instanceof StepError && e.code === "provider_error");
    assert.equal(s.fake.creates().length, before, `no write for ${JSON.stringify(sh.body).slice(0, 40)}`);
  }
});

test("policy: a deny on provision.coolify.private_key creates nothing and is not an attempt", async () => {
  const s = await setup();
  const deny = async (action) => (action === "provision.coolify.private_key" ? "deny" : "allow");
  await assert.rejects(s.run(deny), (e) => e.code === "policy_denied" && e.countsAsAttempt === false);
  assert.equal(keyPosts(s.fake).length, 0);
});

test("teardown ops: inspect sees ownership, remove is one DELETE, a second remove (404) is already gone", async () => {
  const s = await setup();
  await s.run();
  const inv = (kind) => s.store.resources.find((r) => r.kind === kind);
  const cOps = coolifyPrivateKeyOps(s.cf, P.id);
  const gOps = githubDeployKeyOps(s.gh, P.id);
  assert.deepEqual(await cOps.inspect(inv("private_key")), { owned: true });
  assert.deepEqual(await gOps.inspect(inv("deploy_key")), { owned: true });
  assert.deepEqual(await coolifyPrivateKeyOps(s.cf, "99999999-2222-4333-8444-555555555555").inspect(inv("private_key")), { owned: false });
  await gOps.remove(inv("deploy_key"));
  await cOps.remove(inv("private_key"));
  assert.equal(s.fake.keys.size, 0);
  assert.equal(ghKeys(s.fake).length, 0);
  await gOps.remove(inv("deploy_key"));
  await cOps.remove(inv("private_key"));
  assert.equal(await cOps.inspect(inv("private_key")), null);
  assert.equal(await gOps.inspect(inv("deploy_key")), null);
  assert.equal(s.fake.creates().filter((c) => c.method === "DELETE").length, 4);
  await assert.rejects(gOps.remove({ ...inv("deploy_key"), externalId: "a/b#x" }), /github-deploy-key-id-invalid/);
});
