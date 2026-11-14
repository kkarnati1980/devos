import { createHash, randomUUID } from "node:crypto";
// Fake GitHub and Coolify APIs behind a fetch() stub. Every request is recorded; failures can be injected.
export function fakeProviders() {
  const repos = new Map(); // full_name -> body
  const projects = new Map(); // uuid -> body
  const apps = new Map(); // uuid -> application body (M2.4-c2a)
  const keys = new Map(); // uuid -> Coolify private key (M2.4-c2c1); the list returns private_key too, like Coolify
  const deployKeys = new Map(); // full_name -> [{ id, title, key, read_only }] (M2.4-c2c1)
  const calls = [];
  let n = 0;
  // inject: list of { match(method, path) -> bool, action: "timeout-after" | "timeout-before" | {status} , once }
  const faults = [];
  // gitEmpty409: like GitHub, the Git Data API and ref reads answer 409 on a repo with no commits (M2.4-b).
  const state = { login: "kkarnati1980", gitEmpty409: true };
  const git = new Map(); // full_name -> { blobs, trees, commits, main }
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  const gitOf = (full) => { const k = full.toLowerCase(); if (!git.has(k)) git.set(k, { blobs: new Map(), trees: new Map(), commits: new Map(), main: null }); return git.get(k); };
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const timeout = () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; return e; };

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    const auth = init.headers?.authorization;
    calls.push({ origin: u.origin, method, path, body: init.body ? JSON.parse(init.body) : undefined, auth });
    const f = faults.find((x) => !x.used && x.match(method, path, u.origin));
    if (f && f.once !== false) f.used = true;
    if (f?.action === "timeout-before") throw timeout();
    if (f?.action?.status && !f.after) return json(f.action.status, { message: "injected" });
    let res;
    if (u.origin === "https://api.github.com") res = github(method, path, init);
    else if (u.origin === "http://coolify.test:8000") res = coolify(method, path, init);
    else res = json(599, { message: "unknown origin" });
    if (f?.action === "timeout-after") throw timeout();
    if (f?.after && f.action?.status) return json(f.action.status, { message: "injected after" });
    return res;
  }

  const github = (method, path, init) => {
    let m;
    if (method === "GET" && path === "/user") return json(200, { login: state.login });
    if (method === "GET" && (m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
      const r = repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      return r ? json(200, r) : json(404, { message: "Not Found" });
    }
    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(git\/.+|contents\/.+)$/))) {
      const full = `${m[1]}/${m[2]}`;
      if (!repos.has(full.toLowerCase())) return json(404, { message: "Not Found" });
      return gitApi(gitOf(full), method, m[3], init);
    }
    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/keys(?:\/(\d+))?$/))) {
      const full = `${m[1]}/${m[2]}`.toLowerCase();
      if (!repos.has(full)) return json(404, { message: "Not Found" });
      const list = deployKeys.get(full) ?? [];
      deployKeys.set(full, list);
      if (m[3]) {
        const i = list.findIndex((k) => k.id === Number(m[3]));
        if (i < 0) return json(404, { message: "Not Found" });
        if (method === "GET") return json(200, list[i]);
        if (method === "DELETE") { list.splice(i, 1); return json(204); }
      }
      if (method === "GET") return json(200, list.map((k) => ({ ...k })));
      if (method === "POST") {
        const b = JSON.parse(init.body);
        const key = String(b.key).split(" ").slice(0, 2).join(" ");
        if ([...deployKeys.values()].some((l) => l.some((k) => k.key === key))) return json(422, { message: "key is already in use" });
        const k = { id: ++n, title: b.title, key, read_only: b.read_only === true, verified: true };
        list.push(k);
        return json(201, k);
      }
    }
    if (method === "POST" && path === "/user/repos") {
      const b = JSON.parse(init.body);
      const full = `kkarnati1980/${b.name}`;
      if (repos.has(full.toLowerCase())) return json(422, { message: "name already exists on this account" });
      const r = { id: ++n, name: b.name, full_name: full, private: b.private, description: b.description };
      repos.set(full.toLowerCase(), r);
      return json(201, r);
    }
    return json(404, { message: "Not Found" });
  };

  function gitApi(g, method, sub, init) {
    let m;
    const b = init.body ? JSON.parse(init.body) : {};
    const empty = () => json(409, { message: "Git Repository is empty." });
    if (sub.startsWith("contents/") && method === "PUT") {
      if (g.main) return json(422, { message: "sha wasn't supplied" });
      const content = Buffer.from(b.content, "base64");
      const blob = sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
      g.blobs.set(blob, content);
      const tree = sha1(JSON.stringify([[sub.slice(9), "100644", blob]]));
      g.trees.set(tree, [{ path: sub.slice(9), mode: "100644", type: "blob", sha: blob }]);
      const c = sha1(`commit ${tree} ${++n}`);
      g.commits.set(c, { tree, parents: [] });
      g.main = c;
      return json(201, { commit: { sha: c } });
    }
    if (method === "GET" && sub === "git/ref/heads/main") {
      if (!g.main) return state.gitEmpty409 && g.commits.size === 0 ? empty() : json(404, { message: "Not Found" });
      return json(200, { ref: "refs/heads/main", object: { type: "commit", sha: g.main } });
    }
    if (method === "GET" && (m = sub.match(/^git\/commits\/([0-9a-f]{40})$/))) {
      const c = g.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = sub.match(/^git\/blobs\/([0-9a-f]{40})$/))) {
      const b64 = g.blobs.get(m[1]);
      return b64 ? json(200, { sha: m[1], encoding: "base64", content: b64.toString("base64").replace(/(.{60})/g, "$1\n") }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = sub.match(/^git\/trees\/([0-9a-f]{40})$/))) {
      const t = g.trees.get(m[1]);
      return t ? json(200, { sha: m[1], tree: t, truncated: false }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && state.gitEmpty409 && g.commits.size === 0) return empty();
    if (method === "POST" && sub === "git/blobs") {
      const content = Buffer.from(b.content, "base64");
      const blob = sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
      g.blobs.set(blob, content);
      return json(201, { sha: blob });
    }
    if (method === "POST" && sub === "git/trees") {
      if (!b.tree.every((e) => g.blobs.has(e.sha))) return json(422, { message: "tree entry not found" });
      const tree = sha1(JSON.stringify(b.tree.map((e) => [e.path, e.mode, e.sha])));
      g.trees.set(tree, b.tree.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })));
      return json(201, { sha: tree });
    }
    if (method === "POST" && sub === "git/commits") {
      if (!g.trees.has(b.tree) || !b.parents.every((p) => g.commits.has(p))) return json(422, { message: "bad object" });
      const c = sha1(`commit ${b.tree} ${b.parents.join(",")} ${++n}`);
      g.commits.set(c, { tree: b.tree, parents: b.parents, message: b.message });
      return json(201, { sha: c });
    }
    if (method === "POST" && sub === "git/refs") {
      if (b.ref !== "refs/heads/main") return json(422, { message: "only main in the fake" });
      if (g.main) return json(422, { message: "Reference already exists" });
      if (!g.commits.has(b.sha)) return json(422, { message: "Object does not exist" });
      g.main = b.sha;
      return json(201, { ref: b.ref, object: { sha: b.sha } });
    }
    if (method === "PATCH" && sub === "git/refs/heads/main") {
      const c = g.commits.get(b.sha);
      if (!g.main || !c) return json(422, { message: "Reference does not exist" });
      if (b.force !== false || !c.parents.includes(g.main)) return json(422, { message: "Update is not a fast forward" });
      g.main = b.sha;
      return json(200, { object: { sha: b.sha } });
    }
    return json(404, { message: "Not Found" });
  }

  function coolify(method, path, init) {
    let m;
    if ((m = path.match(/^\/api\/v1\/applications\/([^/]+)\/envs$/))) {
      // M2.4-c2b: like Coolify, the list returns values too; POST adds a key, PATCH updates an existing one.
      const a = apps.get(m[1]);
      if (!a) return json(404, { message: "Application not found." });
      a.envs ??= [];
      if (method === "GET") return json(200, a.envs.map((e) => ({ ...e })));
      const b = JSON.parse(init.body);
      if (typeof b.key !== "string" || typeof b.value !== "string") return json(422, { message: "Validation failed." });
      const prev = a.envs.find((e) => e.key === b.key && e.is_preview === Boolean(b.is_preview));
      if (method === "POST") {
        if (prev) return json(409, { message: "Environment variable already exists." });
        a.envs.push({ uuid: `ev${++n}`, key: b.key, value: b.value, is_preview: Boolean(b.is_preview), is_literal: Boolean(b.is_literal) });
        return json(201, { uuid: `ev${n}` });
      }
      if (method === "PATCH") {
        if (!prev) return json(404, { message: "Environment variable not found." });
        prev.value = b.value;
        return json(201, { uuid: prev.uuid });
      }
    }
    if (path === "/api/v1/security/keys") {
      if (method === "GET") return json(200, [...keys.values()].map((k) => ({ ...k })));
      if (method === "POST") {
        const b = JSON.parse(init.body);
        if (typeof b.private_key !== "string" || !b.private_key.startsWith("-----BEGIN OPENSSH ")) return json(422, { message: "Validation failed." });
        const uuid = `pk${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        keys.set(uuid, { id: ++n, uuid, name: b.name, description: b.description ?? null, private_key: b.private_key, is_git_related: false });
        return json(201, { uuid });
      }
    }
    if ((m = path.match(/^\/api\/v1\/security\/keys\/([^/]+)$/)) && method === "DELETE") {
      if (!keys.delete(m[1])) return json(404, { message: "Private Key not found." });
      return json(200, { message: "Private Key deleted." });
    }
    if (method === "GET" && path === "/api/v1/applications") return json(200, [...apps.values()].map(({ uuid, name, description }) => ({ uuid, name, description })));
    if (method === "POST" && (path === "/api/v1/applications/dockercompose" || path === "/api/v1/applications/private-deploy-key")) {
      const b = JSON.parse(init.body);
      if (path.endsWith("/private-deploy-key")) {
        // M2.4-c2c2: like Coolify, a git application needs a stored key, a repo, a branch and a build pack.
        if (!keys.has(b.private_key_uuid) || typeof b.git_repository !== "string" || typeof b.git_branch !== "string" || typeof b.build_pack !== "string" || !/^\d+(,\d+)*$/.test(b.ports_exposes ?? "")) {
          return json(422, { message: "Validation failed." });
        }
      }
      const p = projects.get(b.project_uuid);
      if (!p || !(p.environments ?? []).includes(b.environment_name)) return json(404, { message: "Project or environment not found." });
      if (typeof b.docker_compose_raw !== "string" || !b.server_uuid) return json(422, { message: "Validation failed." });
      // Like Coolify, a domain is generated unless the create turns it off (decision 1 forbids one).
      if (b.autogenerate_domain !== false) b.fqdn = `http://${b.name}.sslip.io`;
      const uuid = `ap${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      apps.set(uuid, { uuid, name: b.name, description: b.description ?? null, ...b });
      return json(201, { uuid });
    }
    if (method === "GET" && path === "/api/v1/projects") return json(200, [...projects.values()].map(({ uuid, name, description }) => ({ uuid, name, description })));
    if ((m = path.match(/^\/api\/v1\/projects\/([^/]+)\/environments$/))) {
      const p = projects.get(m[1]);
      if (!p) return json(404, { message: "Project not found." });
      p.environments ??= [];
      if (method === "GET") return json(200, p.environments.map((name, i) => ({ id: i + 1, name })));
      if (method === "POST") {
        const b = JSON.parse(init.body);
        if (p.environments.includes(b.name)) return json(409, { message: "Environment already exists." });
        p.environments.push(b.name);
        return json(201, { uuid: `env-${b.name}` });
      }
    }
    if (method === "GET" && (m = path.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
      const p = projects.get(m[1]);
      return p ? json(200, p) : json(404, { message: "Project not found." });
    }
    if (method === "POST" && path === "/api/v1/projects") {
      const b = JSON.parse(init.body);
      const uuid = `cf${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      // Coolify v4 creates a `production` environment with every new project (M0.4 04b checks for it first).
      projects.set(uuid, { uuid, name: b.name, description: b.description ?? null, environments: ["production"] });
      return json(201, { uuid });
    }
    return json(404, { message: "Not Found" });
  }

  const creates = () => calls.filter((c) => c.method !== "GET");
  return { fetchImpl, calls, creates, repos, projects, apps, keys, deployKeys, faults, state, git, gitOf };
}
