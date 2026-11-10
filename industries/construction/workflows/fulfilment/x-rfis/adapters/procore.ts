// Procore: RFIs. Reads and the RFI draft (with its question) go through draft operations. Opening the RFI to an assignee
// (which makes Procore notify them) is only ever queued for a person to approve. Fields come from Procore's own RFI
// reference page (developers.procore.com/reference/rest/v1/rfis, read 11 Nov 2026): the create body is `{ rfi: {...} }`
// and requires `subject`, `question` and `rfi_manager_id`; `draft: true` makes a draft; `assignee_ids` and `due_date` are
// set on the RFI. The company header and token come from the platform file (PROCORE_COMPANY_ID, PROCORE_ACCESS_TOKEN).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type RfiRow, type Settings, clean } from "../types.ts";

const P = "procore";
/** Procore op ids are `<tag>.<name>` in the kit's map. */
const OP = { list: "rfis.list-rfis", create: "rfis.create-rfi", update: "rfis.update-rfi" };
export const PLATFORM_NAME = "Procore";
/** Procore takes the question in the create call, so there is no separate "set question" step. */
export const QUESTION_ON_CREATE = true;

const PER_PAGE = 100;
/** Most pages one changed-RFI list is followed through. Beyond it the list is refused, never read in part. */
export const MAX_RFI_PAGES = 20;

/** Ids in Procore are integers. Settings and rows carry them as digit strings; anything else is refused before a call. */
const num = (v: unknown) => { const s = String(v ?? ""); if (!/^[1-9]\d{0,11}$/.test(s)) throw new Error("procore: bad id"); return Number(s); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Procore's range filters take whole seconds: "2026-11-07T00:00:00Z...2026-11-08T00:00:00Z". */
const secs = (iso: string) => iso.replace(/\.\d+Z$/, "Z");

/**
 * RFIs in a project changed between a time and now, every page followed with page and per_page (the two paging inputs
 * Procore's list page documents). Procore's page does not state a maximum per_page, so a short page is NOT taken as the
 * last: paging runs until a page comes back EMPTY. A server that ignored `page` would never return an empty page, so the
 * window runs to the page cap and is refused whole (the watermark is held and the intake log says so) rather than read in
 * part. `complete` is false only then: the rows are dropped, never read in part.
 */
export async function rfisUpdatedSince(ctx: Ctx<Settings>, project: string, since: string): Promise<{ rows: RfiRow[]; complete: boolean }> {
  const pid = num(project);
  const window = `${secs(since)}...${secs(ctx.now.toISOString())}`;
  const rows = new Map<string, RfiRow>();
  for (let page = 1; page <= MAX_RFI_PAGES; page++) {
    const r = await ctx.draft<any[]>({ platform: P, op: OP.list, summary: `RFIs changed since ${since}, page ${page}`,
      input: { params: { project_id: pid, page, per_page: PER_PAGE, "filters[updated_at]": window } } });
    // A 200 whose body is not a list (an error object, an HTML page) is a failed read, never an empty page: an empty page would end the window and move the watermark past RFIs never read.
    if (!Array.isArray(r.data)) throw new Error("procore: the RFI list did not come back as a list");
    const list = r.data;
    for (const x of list) {
      if (!Number.isInteger(x?.id) || x.id <= 0) continue;
      rows.set(String(x.id), { id: String(x.id), project: String(pid), name: clean(x.subject, 160), status: clean(x.status, 40),
        due: clean(x.due_date, 20), updated: clean(x.updated_at, 40), seen: ctx.now.toISOString() });
    }
    if (list.length === 0) return { rows: [...rows.values()], complete: true };
  }
  return { rows: [], complete: false };
}

/**
 * Create the RFI as a draft in Procore with its question. Returns its id at once so a failed later step never creates a
 * second one. `draft: true` keeps it a draft; the assignee is set only by the queued open.
 */
export async function createRfiDraft(ctx: Ctx<Settings>, project: string, name: string, question: string): Promise<string> {
  const pid = num(project);
  const manager = ctx.settings.procore?.rfi_manager_id;
  if (!Number.isInteger(manager) || (manager as number) <= 0) throw new Error("procore: set procore.rfi_manager_id (the RFI manager's user id) in settings");
  const subject = clean(name, 160), body = clean(question, 4000);
  if (!subject || !body) throw new Error("procore: an RFI needs a name and a question");
  const r = await ctx.draft<any>({ platform: P, op: OP.create, summary: `RFI draft: ${clean(name, 80)}`,
    input: { params: { project_id: pid }, body: { rfi: { subject, question: { body }, rfi_manager_id: manager, draft: true } } } });
  if (!Number.isInteger(r.data?.id) || r.data.id <= 0) throw new Error("procore: RFI created but no id came back");
  return String(r.data.id);
}

/** Not used for Procore: the question goes in with the create call. Kept so both RFI adapters have the same shape. */
export async function setQuestion(): Promise<void> { /* the create call already carried the question */ }

/**
 * Queue the step that opens the RFI to an assignee with a due date: the update that sets draft to false, the assignee
 * and the due date. Procore notifies the assignee, so only a person sends it. Procore's RFI has no free-text message on
 * open (the question is the text), so none is sent.
 */
export function queueRfiOpen(ctx: Ctx<Settings>, rfi: { project: string; id: string; name: string }, assignee: number, due: string, _message: string): Promise<string> {
  if (!Number.isInteger(assignee) || assignee <= 0) throw new Error("procore: assignee must be a user id");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("procore: due must be a date (YYYY-MM-DD)");
  const pid = num(rfi.project), rid = num(rfi.id);
  // The approver sees what Procore will do: cleaned, capped and escaped.
  const summary = `open RFI "${esc(clean(rfi.name, 120))}" to user ${assignee}, due ${due} (Procore notifies them)`;
  return ctx.queue({ platform: P, op: OP.update, key: `rfi-open:${rid}`, summary,
    input: { params: { project_id: pid, id: rid }, body: { rfi: { draft: false, assignee_ids: [assignee], due_date: due } } } }, summary);
}
