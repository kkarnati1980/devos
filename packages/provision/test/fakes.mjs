import { randomUUID } from "node:crypto";
// Fake GitHub and Coolify APIs behind a fetch() stub. Every request is recorded; failures can be injected.
export function fakeProviders() {
  const repos = new Map(); // full_name -> body
  const projects = new Map(); // uuid -> body
  const calls = [];
  let n = 0;
  // inject: list of { match(method, path) -> bool, action: "timeout-after" | "timeout-before" | {status} , once }
  const faults = [];
  const state = { login: "kkarnati1980" };
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

  function coolify(method, path, init) {
    let m;
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
      projects.set(uuid, { uuid, name: b.name, description: b.description ?? null });
      return json(201, { uuid });
    }
    return json(404, { message: "Not Found" });
  }

  const creates = () => calls.filter((c) => c.method !== "GET");
  return { fetchImpl, calls, creates, repos, projects, faults, state };
}
