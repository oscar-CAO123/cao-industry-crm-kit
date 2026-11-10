// Shared shapes for the employee-records workflow. Each adapter speaks these, so every cron reads the same records.

export type Platform = "employment-hero" | "docusign";

export interface Settings {
  business_name?: string;
  employment_hero: {
    organisation_id: string;
    employing_entity_id: string;
    work_location?: { id: string; name: string; country: string };
  };
  docusign: { template_id: string; role_name: string };
}

/** A confirmed new hire. The owner or the agent skill writes it to the "hires" store with status "confirmed". */
export interface Hire {
  id: string; first_name: string; last_name: string; email: string; date_of_birth?: string;
  status: "confirmed" | "employee-queued" | "employee-created" | "contract-queued" | "contract-sent" | "stopped";
  employee_id?: string; reason?: string;
}

/** A pay rise or an employment detail change, written to the "changes" store with status "open". */
export interface Change {
  id: string; employee_id: string; kind: "salary" | "employment"; status: "open" | "queued" | "stopped" | "failed" | "rejected"; reason?: string;
  effective_date?: string; award_id?: string; classification_id?: string; change_reason?: string;
  cost_centre_id?: string; primary_manager_id?: string; secondary_manager_id?: string; team_ids?: string[];
}

/** A review cycle, written to the "review-plans" store with status "open". */
export interface ReviewPlan {
  id: string; name: string; status: "open" | "queued" | "stopped" | "failed" | "rejected"; reason?: string; template_ids: string[];
  employee_start_date: string; employee_end_date: string; employee_lock_out_date: string;
  reviewer_start_date: string; reviewer_end_date: string; reviewer_lock_out_date: string;
}

export const ID = /^[A-Za-z0-9-]{1,80}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const NAME = /^[\p{L}][\p{L}\p{M} '.-]{0,79}$/u;
export const TEXT = /^[^\u0000-\u001f]{1,200}$/;

export function check(ok: boolean, msg: string): void { if (!ok) throw new Error(msg); }

export function idList(v: unknown, what: string): string[] {
  check(Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every((x) => typeof x === "string" && ID.test(x)), `${what}: bad id list`);
  return v as string[];
}

/** A plain-text reason the hire cannot be queued, or null when it can. */
export function hireProblem(h: Hire): string | null {
  if (!ID.test(h.id ?? "")) return "bad hire id";
  if (!NAME.test(h.first_name ?? "") || !NAME.test(h.last_name ?? "")) return "first or last name is missing or not plain text";
  if (!EMAIL.test(h.email ?? "")) return "email is missing or not valid";
  if (h.date_of_birth && !DATE.test(h.date_of_birth)) return "date of birth is not YYYY-MM-DD";
  return null;
}

/** A plain-text reason the change cannot be queued, or null when it can. */
export function changeProblem(c: Change): string | null {
  if (!ID.test(c.id ?? "") || !ID.test(c.employee_id ?? "")) return "bad change or employee id";
  if (c.kind === "salary") {
    if (!DATE.test(c.effective_date ?? "") || !ID.test(c.award_id ?? "") || !ID.test(c.classification_id ?? "") || !TEXT.test(c.change_reason ?? ""))
      return "salary change needs effective_date, award_id, classification_id and change_reason";
    return null;
  }
  if (c.kind === "employment") {
    const ids = [c.cost_centre_id, c.primary_manager_id, c.secondary_manager_id];
    const present = ids.filter((v) => v !== undefined);
    if (c.team_ids === undefined && present.length === 0) return "employment change names no field to change";
    if (!ids.every((v) => v === undefined || ID.test(v))) return "a manager or cost centre id is not valid";
    if (c.team_ids !== undefined && !(Array.isArray(c.team_ids) && c.team_ids.every((v) => ID.test(v)))) return "team ids are not valid";
    return null;
  }
  return "change kind must be salary or employment";
}

/** A plain-text reason the review cycle cannot be queued, or null when it can. */
export function planProblem(p: ReviewPlan): string | null {
  if (!ID.test(p.id ?? "")) return "bad review plan id";
  if (!TEXT.test(p.name ?? "")) return "review name is missing";
  if (!Array.isArray(p.template_ids) || p.template_ids.length === 0 || !p.template_ids.every((v) => ID.test(v))) return "review template ids are not valid";
  const dates = [p.employee_start_date, p.employee_end_date, p.employee_lock_out_date, p.reviewer_start_date, p.reviewer_end_date, p.reviewer_lock_out_date];
  if (!dates.every((d) => DATE.test(d ?? ""))) return "a review date is not YYYY-MM-DD";
  return null;
}
