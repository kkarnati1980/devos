import { mockSource } from "./mock";
import type { DashboardSource } from "./types";

/** The only source in M1.3 is the mock. The API source is added with the project routes (M1.5/M2.3). */
export function getSource(): DashboardSource {
  return mockSource;
}

const SLUG = /^[a-z0-9-]{2,40}$/;
export function isSlug(value: string): boolean {
  return SLUG.test(value);
}
