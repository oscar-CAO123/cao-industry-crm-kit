// Fieldwire: RFIs. Reads, the RFI draft and its question go through draft operations. Opening an RFI to the designer
// (which makes Fieldwire email them) is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type RfiRow, type Settings, UUID, clean, idOr } from "../types.ts";

const P = "fieldwire";
const OP = (id: string) => `fieldwire-regional-api.${id}`;

/** The version header is required on every regional call. It is a setting, never a guess. */
function version(s: Settings): Record<string, string> {
  const v = s.fieldwire?.api_version ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("fieldwire: set fieldwire.api_version (a date) in settings");
  return { "Fieldwire-Version": v };
}
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("fieldwire: bad id"); return s; };

/** RFIs in a project changed since a time (first page; paging is not followed yet, see gaps). */
export async function rfisUpdatedSince(ctx: Ctx<Settings>, project: string, since: string): Promise<RfiRow[]> {
  const pid = uuid(project);
  const r = await ctx.draft<any[]>({ platform: P, op: OP("get_rfis_in_project"), summary: `RFIs changed since ${since}`,
    input: { params: { ...version(ctx.settings), project_id: pid, "filters[updated_at_gt]": since } } });
  return (Array.isArray(r.data) ? r.data : []).filter((x) => UUID.test(String(x?.id ?? ""))).map((x): RfiRow => ({
    id: String(x.id), project: pid, name: clean(x.name, 160), status: clean(x.mapped_status ?? x.status, 40),
    due: clean(x.due_date, 20), updated: clean(x.updated_at, 40), seen: ctx.now.toISOString(),
  }));
}

/** Create the RFI as a draft in Fieldwire. Returns its id at once so a failed later step never creates a second one. */
export async function createRfiDraft(ctx: Ctx<Settings>, project: string, name: string): Promise<string> {
  const pid = uuid(project);
  const r = await ctx.draft<any>({ platform: P, op: OP("create_rfi_in_project"), summary: `RFI draft: ${clean(name, 80)}`,
    input: { params: { ...version(ctx.settings), project_id: pid }, body: { name: clean(name, 160) } } });
  const id = idOr(r.data?.id ?? r.headers?.get?.("x-record-uuid"));
  if (!id) throw new Error("fieldwire: RFI created but no id came back");
  return id;
}

/** Put the question text on the draft RFI. Fieldwire's create call takes no question, so this is a second, draft-only call. */
export async function setQuestion(ctx: Ctx<Settings>, project: string, rfiId: string, question: string): Promise<void> {
  await ctx.draft({ platform: P, op: OP("update_rfi_by_id"), summary: "RFI question text",
    input: { params: { ...version(ctx.settings), project_id: uuid(project), id: uuid(rfiId) }, body: { question: clean(question, 4000) } } });
}

/** Queue the step that opens the RFI to a designer with a due date. Fieldwire emails the assignee, so only a person sends it. */
export function queueRfiOpen(ctx: Ctx<Settings>, rfi: { project: string; id: string; name: string }, assignee: number, due: string, message: string): Promise<string> {
  if (!Number.isInteger(assignee) || assignee <= 0) throw new Error("fieldwire: assignee must be a user id");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("fieldwire: due must be a date (YYYY-MM-DD)");
  const pid = uuid(rfi.project), rid = uuid(rfi.id);
  const summary = `open RFI "${clean(rfi.name, 120)}" to user ${assignee}, due ${due} (Fieldwire emails them)`;
  return ctx.queue({ platform: P, op: OP("transition_rfi_in_project"), key: `rfi-open:${rid}`, summary,
    input: { params: { ...version(ctx.settings), project_id: pid, id: rid },
             body: { to_state: "open", assignee_user_id: assignee, due_date: due, message: clean(message, 2000) } } }, summary);
}
