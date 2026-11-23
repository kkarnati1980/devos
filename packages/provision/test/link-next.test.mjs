// DEVOS-253, part 3a-1 (docs/modules/M2.4.md, "AT13 probe failure diagnostics, part 3a-1"): the GitHub `Link` header
// parser shared by both owned-repo listing readers, and the transport's 2xx headers. The readers adopt it in part 3a-2.
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, linkNext } from "../dist/index.js";

const TOKEN = "ghp_TESTONLY_not_a_real_token_0123456789";
const OWNER = "kkarnati1980";

// A fake api.github.com: GET /user answers `user` (with an optional X-OAuth-Scopes header).
function fake({ user, scopes }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, auth: init.headers?.authorization });
    if (u.pathname === "/user") {
      return new Response(JSON.stringify(user), { status: 200, headers: scopes === undefined ? {} : { "x-oauth-scopes": scopes } });
    }
    return new Response(null, { status: 404 });
  };
  return { gh: new GitHubClient({ token: () => TOKEN, fetchImpl, sleep: async () => {} }), calls };
}
const pub = { login: OWNER, public_repos: 0, owned_private_repos: 0 };
const linkHasNext = (hd) => linkNext(hd) === "next";

test("DEVOS-21 part 3: the transport returns headers on 2xx answers only", async () => {
  const f = fake({ user: pub, scopes: "repo" });
  const http = await f.gh.http.pinned();
  const ok = await http.get("/user");
  assert.equal(ok.headers?.get("x-oauth-scopes"), "repo");
  const miss = await http.get("/nothing");
  assert.equal(miss.status, 404);
  assert.equal(miss.headers, undefined);
});

test("DEVOS-21 part 3 (r5): linkHasNext reads rel in any parameter position and in a relation list", () => {
  const h = (link) => new Headers({ link });
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; title="More"; rel="next"')), true);
  // Codex PR223-r35 tightened this (was a next page): only next, prev, first and last are pagination relations, so
  // any other relation type, here `prefetch` beside `next`, makes the header unparseable.
  assert.equal(linkNext(h('<https://api.github.com/user/repos?page=2>; rel="prefetch next"')), "malformed");
  assert.equal(linkNext(h('<https://api.github.com/user/repos?page=2>; rel="NEXT"')), "next", "relation names are case-insensitive");
  for (const v of ['<https://x/?page=2>; rel="nex"', '<https://x/?page=2>; rel="nextish"', '<https://x/?page=2>; rel="alternate"', '<https://x/?page=2>; rel="self"']) {
    assert.equal(linkNext(h(v)), "malformed", v);
  }
  assert.equal(linkHasNext(h('<https://api.github.com/user/repos?page=2>; REL=next')), true);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="prev", <https://x/?page=3>; title="t"; rel=next')), true);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="prev", <https://x/?page=9>; rel="last"')), false);
  assert.equal(linkHasNext(h('<https://x/?page=1>; rel="nextish"')), false);
  assert.equal(linkHasNext(h('<https://x/?page=1>; title="rel=next"')), false);
});

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
  // Codex PR223-r14: every relation type is a registered name (r34: extension URI types are unparseable).
  for (const v of ['<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next,"', '<https://x/y>; rel="la;st"', '<https://x/y>; rel="1st"', '<https://x/y>; rel="prev ne@xt"']) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
  // Codex PR223-r34 tightened this (was "none"): an extension URI relation type is unparseable.
  assert.equal(linkNext(h('<https://x/y>; rel="prev https://example.com/rel/more last"')), "malformed", "extension URI types are unparseable");
});

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
});

test("DEVOS-21 part 3 (r16): an earlier rel=last binds later pages", async () => {
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
  // Pre-review (DEVOS-253): a page after the told last page is past the end, whatever it answers.
  assert.equal(linkNext(new Headers(), { ...want(4), bound: { last: 3 } }), "malformed", "a page after the told last page");
});

test("DEVOS-21 part 3 (r34): an extension URI relation type is unparseable", async () => {
  const h = (link) => new Headers({ link });
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  // Codex PR223-r34 tightened these two (were "none" and "next"): GitHub sends only registered relation names.
  for (const v of ['<https://x.example/meta>; rel="urn:example:metadata"', '<https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner>; rel="next tag:example.com,2026:rel"',
    '<https://x/y>; rel="https://example.com:abc/relation"', '<https://x/y>; rel="https://example.com/relation"',
'<https://x/y>; rel="urn:example:rel#one#two"', '<https://x/y>; rel="urn:a%2"', '<https://x/y>; rel="urn:"', '<https://x/y>; rel="1urn:x"', '<https://x/y>; rel="urn:a%zz"', '<https://x/y>; rel="urn:a<b"']) {
    assert.equal(linkNext(h(v), want), "malformed", v);
  }
});

test("DEVOS-21 part 3 (r21): a link without rel, or with two, is malformed", async () => {
  const h = (link) => new Headers({ link });
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" } };
  const next = "https://api.github.com/user/repos?per_page=100&page=2&affiliation=owner";
  assert.equal(linkNext(h(`<${next}>`), want), "malformed", "no parameters");
  assert.equal(linkNext(h(`<${next}>; title="page 2"`), want), "malformed", "no rel");
  assert.equal(linkNext(h(`<${next}>; rel="next"; rel="prev"`), want), "malformed", "two rels");
  assert.equal(linkNext(h(`<https://x/?page=1>; rel="prev", <${next}>`), want), "malformed", "second link has no rel");
  assert.equal(linkNext(h(`<${next}>; rel="next"`), want), "next");
  // A short page whose Link header names page 2 without a rel fails the preflight and the scan.
});

test("DEVOS-21 part 3 (r22): a link with an anchor is malformed", async () => {
  const u = (p) => `https://api.github.com/user/repos?per_page=100&page=${p}&affiliation=owner`;
  const want = { origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: "2", affiliation: "owner" }, bound: { last: null } };
  assert.equal(linkNext(new Headers({ link: `<${u(1)}>; rel="last"; anchor="https://api.github.com/other"` }), want), "malformed");
  assert.equal(linkNext(new Headers({ link: `<${u(2)}>; anchor="https://api.github.com/other"; rel="next"` }), want), "malformed");
  assert.equal(linkNext(new Headers({ link: `<${u(2)}>; rel="next"` }), { ...want, bound: { last: null } }), "next");
});

test("DEVOS-21 part 3 (r25): quoted values follow the quoted-string grammar", () => {
  const h = (link) => ({ get: (k) => (k.toLowerCase() === "link" ? link : null) });
  for (const v of ['<https://x/?page=1>; rel="prev"; title="a\vb"', '<https://x/?page=1>; rel="prev"; title="a\u0001b"', '<https://x/?page=1>; rel="prev"; title="a\\\u0001"', '<https://x/?page=1>; rel="prev"; title="a\u007f"', '<https://x/?page=1>; rel="prev"; title="a\\']) {
    assert.equal(linkNext(h(v)), "malformed", JSON.stringify(v));
  }
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev"; title="a\tb \\"q\\" [x] ~"')), "none");
});

test("DEVOS-21 part 3 (r26): Unicode spaces are malformed", async () => {
  const h = (link) => ({ get: (k) => (k.toLowerCase() === "link" ? link : null) });
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev\u00a0"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>;\u00a0rel="prev"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>; rel="prev",\u2003<https://x/?page=0>; rel="first"')), "malformed");
  assert.equal(linkNext(h('<https://x/?page=1>;\trel="prev  first"')), "none");
  const u = (p) => `https://api.github.com/user/repos?per_page=100&page=${p}&affiliation=owner`;
});

test("DEVOS-21 part 3 (r32): rel=prev and rel=first must name exactly the previous and first pages", async () => {
  const h = (link) => new Headers({ link });
  const u = (pg) => `https://api.github.com/user/repos?per_page=100&page=${pg}&affiliation=owner`;
  const at = (pg) => ({ origin: "https://api.github.com", path: "/user/repos", query: { per_page: "100", page: String(pg + 1), affiliation: "owner" } });
  // GitHub's own header on page 3 of 5 is accepted.
  assert.equal(linkNext(h(`<${u(4)}>; rel="next", <${u(5)}>; rel="last", <${u(1)}>; rel="first", <${u(2)}>; rel="prev"`), at(3)), "next");
  assert.equal(linkNext(h(`<${u(1)}>; rel="first", <${u(2)}>; rel="prev"`), at(3)), "none", "last page of three");
  for (const [v, pg] of [
    [`<${u(2)}>; rel="prev"`, 1], [`<${u(1)}>; rel="prev"`, 1], [`<${u(2)}>; rel="first"`, 1],
    [`<${u(3)}>; rel="prev"`, 3], [`<${u(1)}>; rel="prev"`, 3], [`<${u(2)}>; rel="first"`, 3],
    [`<https://api.github.com/user/repos?per_page=50&page=2&affiliation=owner>; rel="prev"`, 3],
  ]) {
    assert.equal(linkNext(h(v), at(pg)), "malformed", `${v} on page ${pg}`);
  }
});

test("DEVOS-21 part 3 (r33): a present Link header with no link value is unparseable", async () => {
  const h = (link) => new Headers({ link });
  for (const v of ["", ",", ",,", " , ,\t,"]) assert.equal(linkNext(h(v)), "malformed", JSON.stringify(v));
  assert.equal(linkNext(new Headers()), "none", "an absent header is still no next page");
});

