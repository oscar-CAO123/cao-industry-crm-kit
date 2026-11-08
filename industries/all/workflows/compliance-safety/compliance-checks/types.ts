// Shared shapes for the compliance-checks workflow. The adapter reads First AML into these; the crons store and queue them.
export type Platform = "first-aml";

export interface Settings {
  family: "aml-matter-onboarding";
  business_name?: string;
  first_aml: { organization_id?: string; lookback_days?: number; max_pages?: number };
}

/** clear: every check passed or was not needed. waiting: a check is still running. open: a screening or verification result needs a person. */
export type CheckState = "clear" | "waiting" | "open" | "unknown";

export interface PersonCheck {
  kind: "individual" | "entity";
  id: string;
  state: CheckState;
  /** Names of the checks that need a person (for example "sanctions": POSSIBLE_MATCH). */
  open: string[];
  waiting: string[];
}

export interface CaseSummary { caseId: string; caseStatus: string; lastUpdatedOn: string }

export interface CaseRecord extends CaseSummary {
  people: PersonCheck[];
  open_count: number;
  checked: string;
}
