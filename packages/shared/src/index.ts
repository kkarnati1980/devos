export const DEVOS_VERSION = "0.0.0";

/**
 * Structured Codex review verdict, stored per commit SHA.
 * Must match the JSON schema the review runner passes to `codex exec --output-schema`
 * (docs/modules/M0.3.md "Verdict schema"; also the M3.4 contract). All fields required.
 */
export type ReviewSeverity = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  /** 1-based line in `file`; 0 when the finding is not tied to a line. */
  line: number;
  evidence: string;
  consequence: string;
}

export interface ReviewVerdict {
  verdict: "PASS" | "CHANGES_REQUESTED";
  /** Full 40-character commit SHA the verdict applies to. */
  sha: string;
  summary: string;
  findings: ReviewFinding[];
}

export const REVIEW_VERDICT_KEYS = ["verdict", "sha", "summary", "findings"] as const;
export const REVIEW_FINDING_KEYS = ["severity", "file", "line", "evidence", "consequence"] as const;
