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
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Most pages one changed-RFI list is followed through. Beyond it the list is refused, never read in part. */
export const MAX_RFI_PAGES = 20;

/**
 * RFIs in a project changed since a time, every page followed. Fieldwire sends has_more and last_synced_at as response
 * headers, and the next page is asked with last_synced_at set to that value (spec: pagination headers, regional API).
 * `complete` is false when the page cap is hit or a page says more follows with no cursor: the rows are then dropped.
 */
export async function rfisUpdatedSince(ctx: Ctx<Settings>, project: string, since: string): Promise<{ rows: RfiRow[]; complete: boolean }> {
  const pid = uuid(project);
  const rows: RfiRow[] = [];
  let syncedAt: string | undefined;
  for (let page = 1; page <= MAX_RFI_PAGES; page++) {
    const params: Record<string, unknown> = { ...version(ctx.settings), project_id: pid, "filters[updated_at_gt]": since };
    if (syncedAt) params.last_synced_at = syncedAt;
    const r = await ctx.draft<any[]>({ platform: P, op: OP("get_rfis_in_project"), summary: `RFIs changed since ${since}, page ${page}`,
      input: { params } });
    for (const x of Array.isArray(r.data) ? r.data : []) {
      if (!UUID.test(String(x?.id ?? ""))) continue;
      rows.push({ id: String(x.id), project: pid, name: clean(x.name, 160), status: clean(x.mapped_status ?? x.status, 40),
        due: clean(x.due_date, 20), updated: clean(x.updated_at, 40), seen: ctx.now.toISOString() });
    }
    if (r.headers?.get?.("has_more") !== "true") return { rows, complete: true };
    syncedAt = r.headers?.get?.("last_synced_at") ?? undefined;
    if (!syncedAt) break;
  }
  return { rows: [], complete: false };
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
  // The approver sees the exact text Fieldwire will email: cleaned, capped, and escaped.
  const summary = `open RFI "${clean(rfi.name, 120)}" to user ${assignee}, due ${due} (Fieldwire emails them). Message: "${esc(clean(message, 300))}"`;
  return ctx.queue({ platform: P, op: OP("transition_rfi_in_project"), key: `rfi-open:${rid}`, summary,
    input: { params: { ...version(ctx.settings), project_id: pid, id: rid },
             body: { to_state: "open", assignee_user_id: assignee, due_date: due, message: clean(message, 2000) } } }, summary);
}
