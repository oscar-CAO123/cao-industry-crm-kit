// Fieldwire: the field forms, tasks and checklists the crew fills in on site. Reads go through draft operations;
// the one write (emailing a completed form) is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type FormRow, type Settings, UUID, clean, idOr } from "../types.ts";

const P = "fieldwire";
const OP = (id: string) => `fieldwire-regional-api.${id}`;

/** The version header is required on every regional call. It is a setting, never a guess. */
function version(s: Settings): Record<string, string> {
  const v = s.fieldwire?.api_version ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("fieldwire: set fieldwire.api_version (a date) in settings");
  return { "Fieldwire-Version": v };
}
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("fieldwire: bad id"); return s; };

/** Forms in a project changed since a time (first page; paging is not followed yet, see gaps). */
export async function formsUpdatedSince(ctx: Ctx<Settings>, project: string, since: string): Promise<FormRow[]> {
  const pid = uuid(project);
  const r = await ctx.draft<any[]>({ platform: P, op: OP("get_forms_in_project"), summary: `forms changed since ${since}`,
    input: { params: { ...version(ctx.settings), project_id: pid, "filters[updated_at_gt]": since } } });
  return (Array.isArray(r.data) ? r.data : []).filter((f) => UUID.test(String(f?.id ?? ""))).map((f): FormRow => ({
    id: String(f.id), project: pid, name: clean(f.name), template: idOr(f.form_template_id), status: idOr(f.form_template_form_status_id),
    kind: clean(f.kind, 40), created: clean(f.created_at, 40), updated: clean(f.updated_at, 40), seen: ctx.now.toISOString(),
  }));
}

/** Tasks in a project that start inside a window (the pre-start checks for the day). */
export async function tasksStarting(ctx: Ctx<Settings>, project: string, from: string, to: string): Promise<{ id: string; name: string }[]> {
  const pid = uuid(project);
  const r = await ctx.draft<any[]>({ platform: P, op: OP("get_tasks_in_project"), summary: "tasks starting in the window",
    input: { params: { ...version(ctx.settings), project_id: pid, "filters[start_at_gte]": from, "filters[start_at_lte]": to } } });
  return (Array.isArray(r.data) ? r.data : []).filter((t) => UUID.test(String(t?.id ?? ""))).map((t) => ({ id: String(t.id), name: clean(t.name) }));
}

/** The checklist on one task: how many items there are and how many are still open. */
export async function checklistOf(ctx: Ctx<Settings>, project: string, task: string): Promise<{ total: number; open: number }> {
  const r = await ctx.draft<any[]>({ platform: P, op: OP("get_task_check_items_for_tasks"), summary: "task check items",
    input: { params: { ...version(ctx.settings), project_id: uuid(project), task_id: uuid(task) } } });
  const items = Array.isArray(r.data) ? r.data : [];
  return { total: items.length, open: items.filter((i) => i && i.checked !== true).length };
}

/** Queue one completed form to be emailed as a PDF. Nothing is sent until a person approves it. */
export function queueFormEmail(ctx: Ctx<Settings>, form: FormRow, to: string[], subject: string, body: string): Promise<string> {
  const pid = uuid(form.project), fid = uuid(form.id);
  const summary = `email completed form "${clean(subject, 120)}" (PDF) to ${to.join(", ")}`;
  return ctx.queue({ platform: P, op: OP("email_by_form_id"), key: `form-email:${fid}`, summary,
    input: { params: { ...version(ctx.settings), project_id: pid, id: fid },
             body: { email: to.join(","), cc_sender: !!ctx.settings.fieldwire.report_cc_sender, subject, body, kind: "pdf" } } }, summary);
}
