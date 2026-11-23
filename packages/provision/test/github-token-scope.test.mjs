// DEVOS-21 part 3 (docs/modules/M2.4.md, "AT13 probe failure diagnostics, part 3"): the GitHub purge preflight
// accepts a classic token's `repo` scope as proof that it sees every owned repo when GitHub withholds the private count.
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, githubTokenScopeCheck, classicScopes, githubScanner, linkNext } from "../dist/index.js";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const OWNER = "kkarnati1980";

// A fake api.github.com: GET /user answers `user` with the given scopes header; GET /user/repos pages `repos`.
function fake({ user, scopes, repos = 1, list, link, pages }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, auth: init.headers?.authorization });
    if (u.pathname === "/user") {
      return new Response(JSON.stringify(user), { status: 200, headers: scopes === undefined ? {} : { "x-oauth-scopes": scopes } });
    }
    if (u.pathname === "/user/repos") {
      const page = Number(u.searchParams.get("page"));
      const all = list ?? Array.from({ length: repos }, (_, i) => ({ id: i + 1, name: `r${i}`, private: false, owner: { login: OWNER } }));
      const body = pages ? (pages[page] ?? []) : all.slice((page - 1) * 100, page * 100);
      return new Response(JSON.stringify(body), { status: 200, headers: link && page === 1 ? { link } : {} });
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
  const good = { id: 7, name: "r", private: false, owner: { login: OWNER } };
  for (const list of [[{}], [null], [{ ...good, id: "7" }], [{ ...good, name: "" }], [{ ...good, owner: undefined }], [{ ...good, owner: { login: "someone-else" } }], [good, good]]) {
    await assert.rejects(check(fake({ user: { ...pub, public_repos: list.length }, scopes: "repo", list })), /repository list is unreadable/, JSON.stringify(list));
  }
  await check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [{ ...good, owner: { login: OWNER.toUpperCase() } }] }));
});

test("Codex PR223-r3: a short page with a Link rel=next is not the last page", async () => {
  const link = '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next", <https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="last"';
  // Page 1 is short and names page 2, which holds the second repo (Codex PR223-r28: an advertised page is never
  // empty, so the fixture no longer answers page 2 with []); the point is that page 2 is read.
  const repo = (i) => ({ id: i + 1, name: `r${i}`, private: false, owner: { login: OWNER } });
  const pages = { 1: [repo(0)], 2: [repo(1)] };
  const f = fake({ user: { ...pub, public_repos: 2 }, scopes: "repo", pages, link });
  await check(f);
  assert.equal(f.calls.filter((c) => c.path === "/user/repos").length, 2, "page 2 read");
  // With a page cap of 1 the unread next page is refused.
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", pages, link }), { maxPages: 1 }), /repository list is unreadable/);
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

// Codex PR223-r16: (1) the preflight requires the list read to its end with the private count present too, so a page
// cap on a page that still advertises rel=next fails even when the count is met; (2) a last page told by an earlier
// page binds the later ones, so a short page 2 without a Link header is not the end when page 1 named page 3 as last.
test("DEVOS-21 part 3 (r16): the list is read to its end, and an earlier rel=last binds later pages", async () => {
  const u = (pg) => `https://api.github.com/user/repos?per_page=100&page=${pg}&affiliation=owner`;
  const want = (pg) => ({ origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: String(pg + 1), affiliation: "owner" } });
  const bound = { last: null };
  assert.equal(linkNext(new Headers({ link: `<${u(2)}>; rel="next", <${u(3)}>; rel="last"` }), { ...want(1), bound }), "next");
  assert.equal(bound.last, 3);
  assert.equal(linkNext(new Headers(), { ...want(2), bound }), "malformed", "page 2 with no Link header before the told last page");
  assert.equal(linkNext(new Headers({ link: `<${u(3)}>; rel="next", <${u(4)}>; rel="last"` }), { ...want(2), bound: { last: 3 } }), "malformed", "a different last page");
  assert.equal(linkNext(new Headers({ link: `<${u(3)}>; rel="next"` }), { ...want(2), bound: { last: 3 } }), "next");
  assert.equal(linkNext(new Headers(), { ...want(3), bound: { last: 3 } }), "none", "the told last page, no Link");
  assert.equal(linkNext(new Headers({ link: `<${u(4)}>; rel="next"` }), { ...want(3), bound: { last: 3 } }), "malformed", "a next past the told last page");

  // (1) With the private count present: 100 repos on page 1 meet the count, page 1 says next, the cap is 1 page.
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `r${i}`, owner: { login: OWNER } }));
  const f1 = fake({ user: { login: OWNER, public_repos: 50, owned_private_repos: 50 }, list: full.concat([{ id: 999, name: "late", owner: { login: OWNER } }]), link: `<${u(2)}>; rel="next"` });
  await assert.rejects(githubTokenScopeCheck(f1.gh, { owner: OWNER, maxPages: 1 })(), /repository list is unreadable/);

  // (2) Both readers: page 1 (full) names next=2 and last=3; page 2 is short with no Link header.
  const link = `<${u(2)}>; rel="next", <${u(3)}>; rel="last"`;
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 101 }, scopes: "repo", list: full.concat([{ id: 999, name: "p2", owner: { login: OWNER } }]), link })), /repository list is unreadable/);
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const mk = (n, k) => Array.from({ length: n }, (_, i) => ({ full_name: `${OWNER}/o${k}-${i}`, name: `o${k}-${i}`, description: null }));
    const body = page === 1 ? mk(100, 1) : page === 2 ? mk(1, 2) : [];
    return new Response(JSON.stringify(body), { status: 200, headers: page === 1 ? { link } : {} });
  };
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} });
  await assert.rejects(githubScanner(gh).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /unreadable Link header/);
});

// Codex PR223-r17: a full page is the end when a validated rel=last names it, so exactly maxPages × 100 repos read
// as complete in both readers; a full last page without any rel=last stays inconclusive (unchanged).
test("DEVOS-21 part 3 (r17): a full page named as last by rel=last ends the listing", async () => {
  const u = (pg) => `https://api.github.com/user/repos?per_page=100&page=${pg}&affiliation=owner`;
  const mkRepos = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `r${i}`, owner: { login: OWNER } }));
  const mkFetch = (pages, kind) => async (url) => {
    const x = new URL(url);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 100, owned_private_repos: 100 }), { status: 200 });
    const page = Number(x.searchParams.get("page"));
    const body = kind === "scan" ? Array.from({ length: 100 }, (_, i) => ({ full_name: `${OWNER}/p${page}-${i}`, name: `p${page}-${i}`, description: null }))
      : mkRepos(100).map((e) => ({ ...e, id: e.id + page * 1000, name: `p${page}-${e.name}` }));
    const link = page === 1 ? `<${u(2)}>; rel="next", <${u(2)}>; rel="last"` : `<${u(1)}>; rel="first"`;
    return new Response(JSON.stringify(page <= pages ? body : []), { status: 200, headers: { link } });
  };
  const gh = (k) => new GitHubClient({ token: () => TOKEN, fetchImpl: mkFetch(2, k), sleep: async () => {} });
  await githubTokenScopeCheck(gh("pf"), { owner: OWNER, maxPages: 2 })();
  const hits = await githubScanner(gh("scan"), { maxPages: 2 }).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" });
  assert.deepEqual(hits.filter((h) => h.kind === "scan-incomplete"), []);
  // Without any rel=last, a full final page at the cap is still inconclusive.
  const plain = new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const x = new URL(url);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 100, owned_private_repos: 0 }), { status: 200 });
    return new Response(JSON.stringify(mkRepos(100)), { status: 200 });
  }, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(plain, { owner: OWNER, maxPages: 1 })(), /repository list is unreadable/);
});

// Codex PR223-r18: (1) with the private count present, a repeated repo id never counts twice; (2) an extension
// relation type may be any absolute URI, not only an http(s) one.
test("DEVOS-21 part 3 (r18): identity on the count path, and any absolute URI as a relation type", async () => {
  const dup = [{ id: 1, name: "a", owner: { login: OWNER } }, { id: 1, name: "a", owner: { login: OWNER } }];
  await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 1 }, list: dup })), /repository list is unreadable/);
  await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 1 }, list: [{ id: 1, name: "a" }, { id: "2", name: "b" }] })), /repository list is unreadable/);
  await check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 1 }, list: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }));
  const h = (link) => new Headers({ link });
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  assert.equal(linkNext(h('<https://x.example/meta>; rel="urn:example:metadata"'), want), "none");
  assert.equal(linkNext(h('<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next tag:example.com,2026:rel"'), want), "next");
  for (const v of ['<https://x/y>; rel="urn:example:rel#one#two"', '<https://x/y>; rel="urn:a%2"', '<https://x/y>; rel="urn:"', '<https://x/y>; rel="1urn:x"', '<https://x/y>; rel="urn:a%zz"', '<https://x/y>; rel="urn:a<b"']) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
});

// Codex PR223-r20: on the scope path private entries never stand in for public ones, and every entry says whether
// it is private; on the count path an entry that names another owner is unreadable (an absent owner is allowed).
test("DEVOS-21 part 3 (r20): public entries are counted alone, and a named owner must be the owner", async () => {
  const e = (id, priv, owner = OWNER) => ({ id, name: `r${id}`, private: priv, owner: { login: owner } });
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [e(1, true)] })), /sees 0 of 1 public owned repositories/);
  await check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [e(1, true), e(2, false)] }));
  const { private: _drop, ...noFlag } = e(3, false);
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [noFlag] })), /repository list is unreadable/);
  await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 1 }, list: [e(1, false), e(2, true, "someone-else")] })), /repository list is unreadable/);
  await check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 1 }, list: [e(1, false), { id: 2, name: "b" }] }));
});

// Codex PR223-r21: (1) a link with no rel (or two rels) is malformed, so a target without a relation never reads
// as "no next page"; (2) the leftover scan refuses a repository seen twice across pages (the listing shifted).
test("DEVOS-21 part 3 (r21): a link without rel is malformed, and the scan refuses a repeated repository", async () => {
  const h = (link) => new Headers({ link });
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  const next = "https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner";
  assert.equal(linkNext(h(`<${next}>`), want), "malformed", "no parameters");
  assert.equal(linkNext(h(`<${next}>; title="page 2"`), want), "malformed", "no rel");
  assert.equal(linkNext(h(`<${next}>; rel="next"; rel="prev"`), want), "malformed", "two rels");
  assert.equal(linkNext(h(`<https://x/?page=1>; rel="prev", <${next}>`), want), "malformed", "second link has no rel");
  assert.equal(linkNext(h(`<${next}>; rel="next"`), want), "next");
  // A short page whose Link header names page 2 without a rel fails the preflight and the scan.
  const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme" };
  const noRel = new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const u = new URL(url);
    if (u.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 1, owned_private_repos: 0 }), { status: 200 });
    return new Response(JSON.stringify([{ id: 1, name: "a", full_name: `${OWNER}/a`, private: false, description: null, owner: { login: OWNER } }]), { status: 200, headers: { link: `<${next}>` } });
  }, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(noRel, { owner: OWNER })(), /repository list is unreadable/);
  await assert.rejects(githubScanner(noRel).scan(P), /unreadable Link header/);
  // The scan: page 2 repeats page 1's repository (by full name, any case, or by id) and has no next link.
  const repeat = (second) => new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const body = page === 1 ? [{ id: 7, full_name: `${OWNER}/other`, name: "other", description: null }] : [second];
    return new Response(JSON.stringify(body), { status: 200, headers: page === 1 ? { link: `<${next}>; rel="next"` } : {} });
  }, sleep: async () => {} });
  await assert.rejects(githubScanner(repeat({ id: 7, full_name: `${OWNER}/other`, name: "other", description: null })).scan(P), /returned a repository twice/);
  await assert.rejects(githubScanner(repeat({ full_name: `${OWNER.toUpperCase()}/Other`, name: "Other", description: null })).scan(P), /returned a repository twice/);
  await assert.rejects(githubScanner(repeat({ id: 7, full_name: `${OWNER}/renamed`, name: "renamed", description: null })).scan(P), /returned a repository twice/);
  await assert.rejects(githubScanner(repeat({ id: "8", full_name: `${OWNER}/x`, name: "x", description: null })).scan(P), /malformed entry/);
  // Codex PR223-r27: full_name is exactly `<login>/<name>` with a valid login and repo name, one owner for the whole
  // listing, owner.login agreeing when sent; and with no ids a malformed variant of a seen repo cannot evade the
  // duplicate check.
  for (const bad of [
    { full_name: "/other2", name: "other2", description: null },                       // empty owner
    { full_name: `${OWNER}/x/other2`, name: "other2", description: null },             // extra segment
    { full_name: `${OWNER}/x/other`, name: "other", description: null },               // extra segment, repeat
    { full_name: `-bad/other2`, name: "other2", description: null },                    // invalid login
    { full_name: `${OWNER}/a b`, name: "a b", description: null },                      // invalid repo name
    { full_name: `${OWNER}/..`, name: "..", description: null },
    { full_name: `someone-else/other2`, name: "other2", description: null },           // a second owner
    { full_name: `${OWNER}/other2`, name: "other2", description: null, owner: { login: "someone-else" } },
    { full_name: `${OWNER}/other2`, name: "other2", description: null, owner: {} },
  ]) {
    await assert.rejects(githubScanner(repeat(bad)).scan(P), /malformed entry/, JSON.stringify(bad));
  }
  await assert.rejects(githubScanner(repeat({ full_name: `${OWNER}/OTHER`, name: "OTHER", description: null, owner: { login: OWNER.toUpperCase() } })).scan(P), /returned a repository twice/);
  const ok = await githubScanner(repeat({ id: 8, full_name: `${OWNER}/devos-acme`, name: "devos-acme", description: null })).scan(P);
  assert.deepEqual(ok.map((x) => x.externalId), [`${OWNER}/devos-acme`]);
});

// Codex PR223-r22: an `anchor` moves a link's context to another resource, so a rel=last (or rel=next) with an
// anchor never ends (or continues) this listing; the header is malformed and both readers fail closed.
test("DEVOS-21 part 3 (r22): a link with an anchor is malformed", async () => {
  const u = (p) => `https://api.github.com/user/repos?per_page=100&page=${p}&affiliation=owner`;
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" }, bound: { last: null } };
  assert.equal(linkNext(new Headers({ link: `<${u(1)}>; rel="last"; anchor="https://api.github.com/other"` }), want), "malformed");
  assert.equal(linkNext(new Headers({ link: `<${u(2)}>; anchor="https://api.github.com/other"; rel="next"` }), want), "malformed");
  assert.equal(linkNext(new Headers({ link: `<${u(2)}>; rel="next"` }), { ...want, bound: { last: null } }), "next");
  const mkRepos = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, full_name: `${OWNER}/r${i + 1}`, private: false, description: null, owner: { login: OWNER } }));
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const x = new URL(url);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 100, owned_private_repos: 0 }), { status: 200 });
    return new Response(JSON.stringify(mkRepos(100)), { status: 200, headers: { link: `<${u(1)}>; rel="last"; anchor="https://api.github.com/other"` } });
  }, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(gh, { owner: OWNER, maxPages: 3 })(), /repository list is unreadable/);
  await assert.rejects(githubScanner(gh, { maxPages: 3 }).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /unreadable Link header/);
});

// Codex PR223-r23: the preflight sees each repository name once (case-insensitive) as well as each id, on both paths.
test("DEVOS-21 part 3 (r23): a repeated repository name with a new id never counts twice", async () => {
  const e = (id, name, priv = false) => ({ id, name, private: priv, owner: { login: OWNER } });
  await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 2, owned_private_repos: 0 }, list: [e(1, "a"), e(2, "a")] })), /repository list is unreadable/);
  await assert.rejects(check(fake({ user: { ...pub, public_repos: 2 }, scopes: "repo", list: [e(1, "a"), e(2, "A")] })), /repository list is unreadable/);
  await check(fake({ user: { ...pub, public_repos: 2 }, scopes: "repo", list: [e(1, "a"), e(2, "b")] }));
});

// Codex PR223-r24: an identifiable repo has a positive safe-integer id and a GitHub repo name.
test("DEVOS-21 part 3 (r24): a malformed id or name is an unreadable listing", async () => {
  const e = (id, name) => ({ id, name, private: false, owner: { login: OWNER } });
  for (const bad of [e(-1, "a"), e(0, "a"), e(1.5, "a"), e(Number.MAX_SAFE_INTEGER + 1, "a"), e(1, " "), e(1, "a b"), e(1, ".."), e(1, "x".repeat(101))]) {
    await assert.rejects(check(fake({ user: { login: OWNER, public_repos: 1, owned_private_repos: 0 }, list: [bad] })), /repository list is unreadable/, JSON.stringify(bad));
    await assert.rejects(check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [bad] })), /repository list is unreadable/, JSON.stringify(bad));
  }
  await check(fake({ user: { ...pub, public_repos: 1 }, scopes: "repo", list: [e(1, "my.repo_-1")] }));
  const P = { id: "11111111-2222-4333-8444-555555555555", slug: "acme" };
  for (const id of [-1, 0, 1.5]) {
    const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: async () => new Response(JSON.stringify([{ id, full_name: `${OWNER}/a`, name: "a", description: null }]), { status: 200 }), sleep: async () => {} });
    await assert.rejects(githubScanner(gh).scan(P), /malformed entry/, String(id));
  }
});

// Codex PR223-r25: a quoted value is an RFC 7230 quoted-string; a control character or a dangling `\` is malformed.
test("DEVOS-21 part 3 (r25): quoted values follow the quoted-string grammar", () => {
  const h = (link) => ({ get: (k) => (k.toLowerCase() === "link" ? link : null) });
  for (const v of ['<https://x/?page=1>; rel="prev"; title="a\vb"', '<https://x/?page=1>; rel="prev"; title="a\u0001b"', '<https://x/?page=1>; rel="prev"; title="a\\\u0001"', '<https://x/?page=1>; rel="prev"; title="a\u007f"', '<https://x/?page=1>; rel="prev"; title="a\\']) {
    assert.equal(linkNext(h(v)), "malformed", JSON.stringify(v));
  }
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev"; title="a\tb \\"q\\" [x] ~"')), "none");
});

// Codex PR223-r26: only SP/HTAB separate tokens; a page with more than 100 entries is unreadable in both readers.
test("DEVOS-21 part 3 (r26): Unicode spaces are malformed, and an oversized page is unreadable", async () => {
  const h = (link) => ({ get: (k) => (k.toLowerCase() === "link" ? link : null) });
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev\u00a0"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>;\u00a0rel="prev"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev",\u2003<https://x/?page=0>; rel="first"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>;\trel="prev  first"')), "none");
  const u = (p) => `https://api.github.com/user/repos?per_page=100&page=${p}&affiliation=owner`;
  const many = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, full_name: `${OWNER}/r${i + 1}`, private: false, description: null, owner: { login: OWNER } }));
  const gh = new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const x = new URL(url);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 101, owned_private_repos: 0 }), { status: 200 });
    return new Response(JSON.stringify(many), { status: 200, headers: { link: `<${u(1)}>; rel="last"` } });
  }, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(gh, { owner: OWNER })(), /repository list is unreadable/);
  await assert.rejects(githubScanner(gh).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /more entries than the page size/);
});

// Codex PR223-r28: a page reached through rel=next must not be empty. Page 1 is full and names page 2 as next and
// last; page 2 answers [] with no Link header. Both readers treat that as an unreadable listing, never as its end.
test("DEVOS-21 part 3 (r28): an advertised next page that answers empty is unreadable", async () => {
  const u = (pg) => `https://api.github.com/user/repos?per_page=100&page=${pg}&affiliation=owner`;
  const mk = (kind) => new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const x = new URL(url);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 100, owned_private_repos: 0 }), { status: 200 });
    const page = Number(x.searchParams.get("page"));
    if (page !== 1) return new Response("[]", { status: 200 });
    const body = Array.from({ length: 100 }, (_, i) => (kind === "scan"
      ? { full_name: `${OWNER}/r${i}`, name: `r${i}`, description: null }
      : { id: i + 1, name: `r${i}`, private: false, owner: { login: OWNER } }));
    return new Response(JSON.stringify(body), { status: 200, headers: { link: `<${u(2)}>; rel="next", <${u(2)}>; rel="last"` } });
  }, sleep: async () => {} });
  await assert.rejects(githubTokenScopeCheck(mk("pf"), { owner: OWNER })(), /repository list is unreadable/);
  await assert.rejects(githubScanner(mk("scan")).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" }), /empty page it had advertised/);
});

// Codex PR223-r29: exactly 100 repos on one full page with no Link header. Neither reader can prove the end from
// page 1, so both read page 2; GitHub never advertised it, so its [] is the end and the listing is complete.
test("DEVOS-21 part 3 (r29): a full page without Link, then an unadvertised empty page, is a complete listing", async () => {
  const calls = [];
  const mk = (kind) => new GitHubClient({ token: () => TOKEN, fetchImpl: async (url) => {
    const x = new URL(url);
    calls.push(x.pathname + x.search);
    if (x.pathname === "/user") return new Response(JSON.stringify({ login: OWNER, public_repos: 100, owned_private_repos: 0 }), { status: 200 });
    const page = Number(x.searchParams.get("page"));
    if (page !== 1) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => (kind === "scan"
      ? { full_name: `${OWNER}/r${i}`, name: `r${i}`, description: null }
      : { id: i + 1, name: `r${i}`, private: false, owner: { login: OWNER } }))), { status: 200 });
  }, sleep: async () => {} });
  await githubTokenScopeCheck(mk("pf"), { owner: OWNER })();
  const hits = await githubScanner(mk("scan")).scan({ id: "11111111-2222-4333-8444-555555555555", slug: "acme" });
  assert.deepEqual(hits, []);
  assert.equal(calls.filter((c) => c.includes("page=2")).length, 2, "both readers read page 2 to confirm the end");
});
