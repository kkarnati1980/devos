// DEVOS-21 part 3 (docs/modules/M2.4.md, "AT13 probe failure diagnostics, part 3"): the GitHub purge preflight
// accepts a classic token's `repo` scope as proof that it sees every owned repo when GitHub withholds the private count.
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, githubTokenScopeCheck, classicScopes, githubScanner, linkNext } from "../dist/index.js";

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
const linkHasNext = (hd) => linkNext(hd) === "next";

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
  const link = '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next", <https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="last"';
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

// Codex PR223-r4: the purge's leftover scan reads pages the same way as the preflight. A short first page that
// advertises Link rel=next is not the last page, so a project repo on page 2 is still found.
test("DEVOS-21 part 3 (r4): githubScanner follows Link rel=next past a short page", async () => {
  const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme" };
  const pages = {
    1: [{ full_name: `${OWNER}/other`, name: "other", description: null }],
    2: [{ full_name: `${OWNER}/devos-acme`, name: "devos-acme", description: null }],
  };
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page"));
    seen.push(page);
    const headers = page === 1 ? { link: '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"' } : {};
    return new Response(JSON.stringify(pages[page] ?? []), { status: 200, headers });
  };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} });
  const hits = await githubScanner(gh).scan(P);
  assert.deepEqual(hits.map((h) => h.externalId), [`${OWNER}/devos-acme`]);
  assert.deepEqual(seen, [1, 2]);
  // Without the Link header the short first page is still the last one (unchanged behaviour).
  assert.equal(linkHasNext(new Headers()), false);
  assert.equal(linkHasNext(new Headers({ link: '<https://x/?page=1>; rel="prev"' })), false);
  assert.equal(linkHasNext(new Headers({ link: '<https://x/?page=1>; rel="prev", <https://x/?page=3>; rel="next"' })), true);
});

// Codex PR223-r5: rel may follow other parameters and may hold several relation types; counts must be valid counts.
test("DEVOS-21 part 3 (r5): linkHasNext reads rel in any parameter position and in a relation list", () => {
  const h = (link) => new Headers({ link });
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; title="More"; rel="next"')), true);
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; rel="prefetch next"')), true);
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; REL=next')), true);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="prev", <https://x/?page=3>; title="t"; rel=next')), true);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="prev", <https://x/?page=9>; rel="last"')), false);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="nextish"')), false);
  assert.equal(linkHasNext(h('<https://x/?page=1>; title="rel=next"')), false);
});

test("DEVOS-21 part 3 (r5): a negative, fractional or unsafe count is refused as github-counts", async () => {
  const bad = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN];
  for (const n of bad) {
    await assert.rejects(check(fake({ user: { login: OWNER, public_repos: n }, scopes: "repo", repos: 0 })), /cannot read its account's repository counts/);
    await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 0, owned_private_repos: n }, repos: 0 })), /cannot read its account's repository counts/);
  }
});

// Codex PR223-r6: a `<`, `,` or `;` inside a quoted value never splits a link; an unparseable value fails closed.
test("DEVOS-21 part 3 (r6): linkHasNext tokenizes quoted values and fails closed on a malformed header", () => {
  const h = (link) => new Headers({ link });
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; title="More < results"; rel="next"')), true);
  assert.equal(linkHasNext(h('<https://x/?page=2>; title="a, b; c"; rel="next"')), true);
  assert.equal(linkHasNext(h('<https://x/?page=2>; title="say \\"rel=next\\""; rel="last"')), false);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="prev", <https://x/?page=9>; rel="last"')), false);
  assert.equal(linkHasNext(h("")), false);
  // Malformed (Codex PR223-r8): the caller treats the listing as unreadable.
  assert.equal(linkNext(h("garbage")), "malformed");
  assert.equal(linkNext(h('<https://x/?page=2>; title="unterminated')), "malformed");
  assert.equal(linkNext(h("<https://x/?page=2")), "malformed");
  assert.equal(linkNext(h('<https://x/?page=2>; rel="next", garbage')), "malformed");
  // Codex PR223-r7: a rel without a value, or a nameless parameter, is malformed too.
  for (const v of ["<https://x/?page=2>; rel=", "<https://x/?page=2>; rel", '<https://x/?page=2>; rel=""', '<https://x/?page=2>; rel="  "', "<https://x/?page=2>; =next", "<https://x/?page=2>; ;"]) {
    assert.equal(linkNext(h(v)), "malformed", v);
  }
  assert.equal(linkHasNext(h('<https://x/?page=9>; rel="last"; hreflang=en')), false);
  // Codex PR223-r9: names and unquoted values are RFC 7230 tokens only; any other character is malformed.
  for (const v of ['<https://x/?page=2>; rel=next"', '<https://x/?page=2>; re"l=next', "<https://x/?page=2>; rel=ne<xt", "<https://x/?page=2>; title=a(b); rel=next", "<https://x/?page=2>; ti@tle=x; rel=next", "<https://x/?page=2>; title=; rel=next"]) {
    assert.equal(linkNext(h(v)), "malformed", v);
  }
  // Codex PR223-r10: the target must be a URI reference.
  for (const v of ["<bad target>; rel=last", "<>; rel=last", '<https://x/"q>; rel=last', "<https://x/?a=%zz>; rel=last", "<https://x/{a}>; rel=next"]) {
    assert.equal(linkNext(h(v)), "malformed", v);
  }
  assert.equal(linkNext(h("<https://api.github.com/user/repos?page=2&per_page=100>; rel=\"next\", <https://api.github.com/user/repos?page=5&per_page=100>; rel=\"last\"")), "next");
  assert.equal(linkNext(h("<https://x/a%20b?q=1#f>; rel=last")), "none");
  // Token values with tchar punctuation still parse.
  assert.equal(linkNext(h("<https://x/?page=2>; rel=next; x-a.b_c~=v1!#$%&'*+^`|")), "next");
  assert.equal(linkNext(h("<https://x/?page=2>; rel=last; hreflang=en-US")), "none");
});

// Codex PR223-r8: a malformed Link header on any page makes the listing inconclusive for both readers.
test("DEVOS-21 part 3 (r8): a malformed Link header fails the preflight and the leftover scan", async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 1 }), { status: 200, headers: { "x-oauth-scopes": "repo" } });
    const page = Number(u.searchParams.get("page"));
    const body = page === 1 ? [{ id: 1, name: "other", full_name: `${OWNER}/other`, description: null, owner: { login: OWNER } }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: page === 1 ? { link: "<https://api.github.com/user/repos?page=2>; rel=" } : {} });
  };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(gh, { owner: OWNER })(), /repository list is unreadable/);
  await assert.rejects(githubScanner(gh).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /unreadable Link header/);
});

// Codex PR223-r11: a target with a second `#` is not a URI; and a reader walking pages by count must get a
// `rel=next` that names exactly the page it reads next, or the listing is unreadable (never "complete").
test("DEVOS-21 part 3 (r11): link targets are absolute URIs, and rel=next must name the next page", async () => {
  const h = (link) => new Headers({ link });
  for (const v of ["<https://api.github.com/user/repos#one#two>; rel=last", "<user/repos?page=2>; rel=next", "<https://[::1]/user/repos?page=2>; rel=next",
    // Codex PR223-r12: an invalid authority is unparseable whatever the rel.
    "<https://api.github.com:abc/user/repos?page=2>; rel=last", "<https://u@api.github.com/user/repos>; rel=last", "<https://api.github.com:99999/x>; rel=last", "<ftp://x/y>; rel=last"]) {
    assert.equal(linkNext(h(v)), "malformed", v);
  }
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  assert.equal(linkNext(h('<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"'), want), "next");
  assert.equal(linkNext(h('<https://API.github.com:443/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"'), want), "next", "same origin after normalisation");
  // Codex PR223-r15 tightened this: a rel=last that is not the same request (here: missing parameters) is malformed.
  assert.equal(linkNext(h('<https://api.github.com/user/repos?page=9>; rel="last"'), want), "malformed", "rel=last is checked");
  for (const v of [
    '<https://api.github.com/user/repos?per_page=100&page=3&affiliation=owner>; rel="next"',
    '<https://api.github.com/user/repos?per_page=100&page=02&affiliation=owner>; rel="next"',
    // Codex PR223-r12: a different page size shifts the offset; extra or missing parameters are not the next request.
    '<https://api.github.com/user/repos?per_page=50&page=2&affiliation=owner>; rel="next"',
    '<https://api.github.com/user/repos?page=2&affiliation=owner>; rel="next"',
    '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner&type=all>; rel="next"',
    '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=all>; rel="next"',
    '<https://api.github.com/user/repos?page=2&page=3>; rel="next"',
    '<https://api.github.com/user/repos>; rel="next"',
    // Codex PR223-r13: another origin (scheme, host or port) is not the next request.
    '<http://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"',
    '<https://evil.example/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"',
    '<https://api.github.com:8443/user/repos?per_page=100&page=2&affiliation=owner>; rel="next"',
    '<https://api.github.com/orgs/x/repos?page=2>; rel="next"',
    '<https://api.github.com/evil/user/repos?page=2>; rel="next"',
    '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=3>; rel="next"',
  ]) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
  // Codex PR223-r14: every relation type is a registered name or an absolute URI.
  for (const v of ['<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next,"', '<https://x/y>; rel="la;st"', '<https://x/y>; rel="1st"', '<https://x/y>; rel="prev ne@xt"']) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
  assert.equal(linkNext(h('<https://x/y>; rel="prev https://example.com/rel/more last"')), "none", "extension URI types are allowed");
  // Both readers: page 1 advertises page 3, page 2 is empty with no Link. Neither may read page 2 as the end.
  const link = '<https://api.github.com/user/repos?page=3>; rel="next"';
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", repos: 1, link })), /repository list is unreadable/);
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const body = page === 1 ? [{ full_name: `${OWNER}/other`, name: "other", description: null }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: page === 1 ? { link } : {} });
  };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} });
  await assert.rejects(githubScanner(gh).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /Link header/);
});

// Codex PR223-r15: rel=last says how many pages exist. A last page beyond the current one with no rel=next is
// malformed, so a short page 1 that advertises page 3 as last is never the end of the listing; nor is a rel=next
// when page 1 is the last page; and a rel=last must be the same request with a page no lower than the current one.
test("DEVOS-21 part 3 (r15): rel=last must agree with rel=next", async () => {
  const h = (link) => new Headers({ link });
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  const u = (pg) => `https://api.github.com/user/repos?per_page=100&page=${pg}&affiliation=owner`;
  assert.equal(linkNext(h(`<${u(2)}>; rel="next", <${u(3)}>; rel="last"`), want), "next");
  assert.equal(linkNext(h(`<${u(1)}>; rel="last"`), want), "none", "page 1 is the last page");
  assert.equal(linkNext(h(`<${u(1)}>; rel="first", <${u(1)}>; rel="last"`), want), "none");
  for (const v of [
    `<${u(3)}>; rel="last"`,
    `<${u(2)}>; rel="last"`,
    `<${u(2)}>; rel="next", <${u(1)}>; rel="last"`,
    `<${u(2)}>; rel="next", <${u(3)}>; rel="last", <${u(4)}>; rel="last"`,
    `<${u(0)}>; rel="last"`,
    `<${u("03")}>; rel="last"`,
    `<https://api.github.com/user/repos?per_page=50&page=3&affiliation=owner>; rel="last"`,
    `<https://evil.example/user/repos?per_page=100&page=3&affiliation=owner>; rel="last"`,
    `<https://api.github.com/user/repos?per_page=100&page=3&page=4&affiliation=owner>; rel="last"`,
  ]) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
  // Both readers: a short page 1 that names page 3 as last and has no rel=next is unreadable, never complete.
  const link = `<${u(3)}>; rel="last"`;
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", repos: 1, link })), /repository list is unreadable/);
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const body = page === 1 ? [{ full_name: `${OWNER}/other`, name: "other", description: null }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: page === 1 ? { link } : {} });
  };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} });
  await assert.rejects(githubScanner(gh).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /unreadable Link header/);
});
