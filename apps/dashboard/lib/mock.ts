// M1.3 mock source: 20 deterministic projects (the "Done when" fixture).
// Project "xss-probe" carries seeded hostile text in its spec, an agent summary
// and a log line (Phase PS amendment AT): it must render as inert text.
import {
  MODULE_STATUSES,
  PROJECT_STAGES,
  RUN_ROLES,
  type DashboardSource,
  type ModuleCard,
  type ProjectDetail,
  type ProjectSummary,
} from "./types";
import payloads from "./fixtures/xss-payloads.json";

export const XSS_PAYLOADS: Readonly<Record<"spec" | "summary" | "log" | "name", string>> = Object.freeze(payloads);

const NAMES = [
  "Social content extraction", "Invoice scanner", "Family planner", "Clinic booking", "Trip ledger",
  "Recipe box", "Gym tracker", "Library loans", "Event tickets", "Field survey",
  "Parts catalogue", "Tutor match", "Rent reminders", "Plant care", "Volunteer roster",
  "Car service log", "Garden swap", "Book club", "Help desk",
];

const BASE = Date.UTC(2026, 10, 6, 8, 0, 0); // 6 Nov 2026 08:00 UTC, fixed so output is deterministic
const iso = (minutesAgo: number) => new Date(BASE - minutesAgo * 60_000).toISOString();

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function modulesFor(i: number): ModuleCard[] {
  const count = 6 + (i % 5);
  const cards: ModuleCard[] = [];
  for (let m = 0; m < count; m++) {
    const status = MODULE_STATUSES[(i + m) % MODULE_STATUSES.length]!;
    cards.push({
      key: `M${1 + Math.floor(m / 3)}.${(m % 3) + 1}`,
      title: `Module ${m + 1}`,
      lane: ["A", "B", "C"][m % 3]!,
      status,
      dependsOn: m === 0 ? [] : [cards[m - 1]!.key],
      mergedSha: status === "merged" ? ((i * 7919 + m * 104729) >>> 0).toString(16).padStart(8, "0").repeat(5) : null,
      linearIssue: `P${i + 1}-${m + 1}`,
    });
  }
  return cards;
}

function build(i: number): ProjectDetail {
  const probe = i === 0;
  const name = probe ? XSS_PAYLOADS.name : NAMES[(i - 1) % NAMES.length]!;
  const slug = probe ? "xss-probe" : slugify(name);
  const modules = modulesFor(i);
  const capUsd = 15;
  return {
    slug,
    name,
    stage: PROJECT_STAGES[i % 6]!, // never "purged" on the board
    pausedAt: i % 7 === 3 ? iso(90) : null,
    capUsd,
    spentUsd: Math.round(((i * 1.37) % capUsd) * 100) / 100,
    lanes: 1 + (i % 3),
    modulesMerged: modules.filter((m) => m.status === "merged").length,
    modulesTotal: modules.length,
    pendingApprovals: i % 4,
    updatedAt: iso(i * 13),
    repoUrl: `https://github.com/kkarnati1980/${slug}`,
    previewUrl: null,
    liveUrl: null,
    specExcerpt: probe
      ? `Spec v1. ${XSS_PAYLOADS.spec} The system MUST escape every field.`
      : `Spec v1 for ${name}. DV-FR-001: the user MUST be able to sign in.`,
    modules,
    agentSummaries: RUN_ROLES.slice(0, 3).map((role, k) => ({
      role,
      model: k === 2 ? "codex" : "sonnet",
      occurredAt: iso(i * 13 + k * 5),
      summary: probe && k === 1 ? `Builder notes ${XSS_PAYLOADS.summary}` : `${role} finished step ${k + 1}.`,
    })),
    log: [
      { ts: iso(i * 13 + 1), level: "info", text: "pnpm install --frozen-lockfile: exit 0" },
      { ts: iso(i * 13 + 2), level: probe ? "warn" : "info", text: probe ? `tool output ${XSS_PAYLOADS.log}` : "pnpm test: 12/12 pass" },
    ],
  };
}

export const MOCK_PROJECTS: readonly ProjectDetail[] = Object.freeze(Array.from({ length: 20 }, (_, i) => build(i)));

function summary(p: ProjectDetail): ProjectSummary {
  const { slug, name, stage, pausedAt, capUsd, spentUsd, lanes, modulesMerged, modulesTotal, pendingApprovals, updatedAt } = p;
  return { slug, name, stage, pausedAt, capUsd, spentUsd, lanes, modulesMerged, modulesTotal, pendingApprovals, updatedAt };
}

export const mockSource: DashboardSource = {
  kind: "mock",
  async listProjects() {
    return MOCK_PROJECTS.map(summary);
  },
  async getProject(slug: string) {
    return MOCK_PROJECTS.find((p) => p.slug === slug) ?? null;
  },
};
