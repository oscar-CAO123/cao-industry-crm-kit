// Shared shapes for the agency ops board workflow. The adapter speaks these; the crons never call the vendor directly.

export type Platform = "productive";

export interface Settings {
  business_name?: string;
  productive: {
    ops_project_id: string;        // the internal Productive project that holds ops-board tasks (numeric id)
    brief_deal_status_id: string;  // the deal status that means "new brief, needs scoping" (numeric id)
    task_list_id?: string;         // optional task list inside the ops project (numeric id)
  };
  budget_warning_percent?: number; // default 80
}

export interface Brief { id: string; title: string; company_id?: string; status: "new" | "task-drafted"; task_id?: string; seen: string }
export interface BudgetRow { project_id: string; budget_usage: number; budgeted_time: number; billable_time: number }
export interface Warned { project_id: string; month: string; task_id: string }
export interface Invoice { id: string; number: string; delivery_on: string }

/** Productive ids are numbers sent as strings. Anything else is refused before it reaches a filter, path or body. */
export const ID = /^[0-9]{1,18}$/;
/** Text from a deal, invoice or call is data: strip control characters and cap the length. */
export const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const day = (d: Date) => d.toISOString().slice(0, 10);

export function settingsOk(s: Settings): Settings {
  const p = s.productive;
  if (!p || !ID.test(String(p.ops_project_id)) || !ID.test(String(p.brief_deal_status_id)))
    throw new Error("agency ops: settings.productive needs numeric ops_project_id and brief_deal_status_id");
  if (p.task_list_id !== undefined && !ID.test(String(p.task_list_id))) throw new Error("agency ops: task_list_id must be numeric");
  if (s.budget_warning_percent !== undefined && !(s.budget_warning_percent > 0 && s.budget_warning_percent <= 100))
    throw new Error("agency ops: budget_warning_percent must be between 0 and 100");
  return s;
}
