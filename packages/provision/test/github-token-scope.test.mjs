// DEVOS-21 part 3 (docs/modules/M2.4.md, "AT13 probe failure diagnostics, part 3"): the GitHub purge preflight
// accepts a classic token's `repo` scope as proof that it sees every owned repo when GitHub withholds the private count.
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, githubTokenScopeCheck, classicScopes } from "../dist/index.js";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const OWNER = "kkarnati1980";

// A fake api.github.com: GET /user answers `user` with the given scopes header; GET /user/repos pages `repos`.
function fake({ user, scopes, repos = 1, list, link }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, auth: init.headers?.authorization });
    if (u.pathname === "/user") {
      return new Response(JSON.stringify(user), { status: 200, headers: scopes === undefined ? {} : { "x-oauth-scopes": scopes } });
    }
    if (u.pathname === "/user/repos") {
      const page = Number(u.searchParams.get("page"));
      const all = list ?? Array.from({ length: repos }, (_, i) => ({ id: i + 1, name: `r${i}`, owner: { login: OWNER } }));
      return new Response(JSON.stringify(all.slice((page - 1) * 100, page * 100)), { status: 200, headers: link && page === 1 ? { link } : {} });
    }
    return new Response(null, { status: 404 });
  };
  return { gh: new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} }), calls };
}
const check = (f, opts = {}) => githubTokenScopeCheck(f.gh, { owner: OWNER, ...opts })();
const pub = { login: OWNER, public_repos: 0 };

test("DEVOS-21 part 3: classicScopes reads X-OAuth-Scopes exactly, and nothing from an absent or empty header", () => {
  assert.equal(classicScopes(undefined), null);
  assert.equal(classicScopes(new Headers()), null);
  assert.equal(classicScopes(new Headers({ "x-oauth-scopes": "  " })), null);
  assert.deepEqual(classicScopes(new Headers({ "x-oauth-scopes": "repo, delete_repo" })), ["repo", "delete_repo"]);
  assert.deepEqual(classicScopes(new Headers({ "x-oauth-scopes": ", ," })), []);
});

test("DEVOS-21 part 3: with the private count present, the old count rule runs unchanged", async () => {
  await check(fake({ user: { login: OWNER, public_repos: 0, owned_private_repos: 2 }, repos: 2 }));
  await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 2 }, scopes: "repo", repos: 1 })), /sees 1 of 3/);
});

test("DEVOS-21 part 3: without the count and without a repo scope, the check refuses", async () => {
  await assert.rejects(check(fake({ user: pub })), /cannot read its account's repository counts/, "no header (fine-grained or app token)");
  await assert.rejects(check(fake({ user: pub, scopes: "" })), /cannot read its account's repository counts/, "empty header");
  for (const scopes of ["delete_repo, read:org", "public_repo, delete_repo", "repository, delete_repo", "repo:status", ", ,", "Repo"]) {
    await assert.rejects(check(fake({ user: pub, scopes })), /classic token has no repo scope/, scopes);
  }
});

test("Codex PR223-r1: a present but malformed private count is refused even with a repo scope", async () => {
  for (const bad of [null, "2", { n: 2 }, true]) {
    await assert.rejects(check(fake({ user: { ...pub, owned_private_repos: bad }, scopes: "repo" })), /cannot read its account's repository counts/, JSON.stringify(bad));
  }
});

test("DEVOS-21 part 3: the scope proof never replaces the owner check, a full list read, or the public count", async () => {
  await assert.rejects(check(fake({ user: { ...pub, login: "someone-else" }, scopes: "repo" })), /another account/);
  await assert.rejects(check(fake({ user: pub, scopes: "repo", repos: 100 }), { maxPages: 1 }), /repository list is unreadable/);
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 5 }, scopes: "repo", repos: 1 })), /sees 1 of 5/);
});

test("Codex PR223-r2: on the scope proof, every listed entry must be an identifiable repo of the owner", async () => {
  const good = { id: 7, name: "r", owner: { login: OWNER } };
  for (const list of [[{}], [null], [{ ...good, id: "7" }], [{ ...good, name: "" }], [{ ...good, owner: undefined }], [{ ...good, owner: { login: "someone-else" } }], [good, good]]) {
    await assert.rejects(check(fake({ user: { ...pub, public_repos: list.length }, scopes: "repo", list })), /repository list is unreadable/, JSON.stringify(list));
  }
  await check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [{ ...good, owner: { login: OWNER.toUpperCase() } }] }));
});

test("Codex PR223-r3: a short page with a Link rel=next is not the last page", async () => {
  const link = '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=2>; rel="last"';
  // Page 2 is empty here, so the list ends there; the point is that page 2 is read.
  const f = fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", repos: 1, link });
  await check(f);
  assert.equal(f.calls.filter((c) => c.path === "/user/repos").length, 2, "page 2 read");
  // With a page cap of 1 the unread next page is refused.
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", repos: 1, link }), { maxPages: 1 }), /repository list is unreadable/);
});

test("DEVOS-21 part 3: a classic repo token passes at exactly public_repos, reading every page on one token", async () => {
  const f = fake({ user: { ...pub, public_repos: 150 }, scopes: "delete_repo,repo , workflow", repos: 150 });
  await check(f);
  assert.equal(f.calls.filter((c) => c.path === "/user/repos").length, 2, "both pages read");
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
});

test("DEVOS-21 part 3: the transport returns headers on 2xx answers only", async () => {
  const f = fake({ user: pub, scopes: "repo" });
  const http = await f.gh.http.pinned();
  const ok = await http.get("/user");
  assert.equal(ok.headers?.get("x-oauth-scopes"), "repo");
  const miss = await http.get("/nothing");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers, undefined);
});
