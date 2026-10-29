export const DEVOS_VERSION = "0.0.0";

/** Structured Codex review verdict returned per commit SHA. */
export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  file: string;
  evidence: string;
  consequence: string;
}
export interface ReviewVerdict {
  verdict: "PASS" | "CHANGES_REQUESTED";
  sha: string;
  findings: ReviewFinding[];
}
