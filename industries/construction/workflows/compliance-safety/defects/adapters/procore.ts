// Procore for the defects workflow. A defect is a punch item; the register, the reminders and the close-out run from the
// project's punch list. Field names come from Procore's own punch item reference page (developers.procore.com/reference/
// rest/v1/punch-items, read 11 Nov 2026): the list is GET /rest/v1.1/punch_items with project_id, page and per_page and
// returns items with id, name, status (Open, Closed, Overdue, Pending), closed_at and deleted_at; a comment is POST
// /rest/v1.0/punch_items/{id}/comments with project_id and the body { comment: { body } }.
// Reading is a draft operation. A comment on a punch item is visible to the people on it and may notify them (the page does not say
// either way), so it is only ever queued for a person to approve. Procore already has the trade as the item's assignee, so there are
// no trade emails, no internal task (the punch item is the task) and no client email (the item's own final approver closes it out).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Adapter, Settings } from "../types.ts";

const P = "procore";
const OP = { list: "punch-items.list-punch-items", comment: "punch-items.create-punch-item-comment" };
export const MAX_PUNCH_PAGES = 20;
const PER_PAGE = 100;

/** Ids in Procore are integers, carried as digit strings. Anything else is refused before a call. */
const num = (v: unknown) => { const s = String(v ?? ""); if (!/^[1-9]\d{0,11}$/.test(s)) throw new Error("procore: bad id"); return Number(s); };
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export const procore: Adapter & { queueReminder(ctx: Ctx<Settings>, a: { project: string; item: string; key: string; summary: string; text: string }): Promise<string> } = {
  id: "procore",
  /** The projects named in settings: their punch lists are tracked. */
  async openJobs(ctx) {
    return (ctx.settings.procore?.projects ?? []).slice(0, 100).map((p) => ({ uuid: String(num(p.id)), address: clean(p.name, 200) }));
  },
  /**
   * Every punch item in one project, sorted by id so offset paging is stable (the page lists id as a sort field). Paging runs until a page
   * comes back empty (no page size is assumed); a project with more
   * than 20 pages is refused whole, never read in part, so a truncated list never marks a defect withdrawn.
   */
  async defectItems(ctx, project) {
    const pid = num(project), seen = new Map<string, { uuid: string; name: string; active: boolean; completed_at?: string }>();
    for (let page = 1; page <= MAX_PUNCH_PAGES; page++) {
      const r = await ctx.draft<any[]>({ platform: P, op: OP.list, summary: `punch items in project ${pid}, page ${page}`,
        input: { params: { project_id: pid, page, per_page: PER_PAGE, sort: "id" } } });
      // A 200 that is not a list is a failed read, never an empty page: an empty page would end the list early.
      if (!Array.isArray(r.data)) throw new Error("procore: the punch item list did not come back as a list");
      if (r.data.length === 0) return [...seen.values()];
      for (const x of r.data) {
        // An item with no usable id cannot be tracked, and leaving it out could let a project close with it still open: the list is refused whole.
        if (!Number.isInteger(x?.id) || x.id <= 0) throw new Error("procore: a punch item came back with no usable id; the list is refused whole");
        const closed = String(x.status ?? "").toLowerCase() === "closed";
        seen.set(String(x.id), { uuid: String(x.id), name: clean(x.name, 200), active: !x.deleted_at, completed_at: closed ? clean(x.closed_at || x.updated_at, 40) || undefined : undefined });
      }
    }
    throw new Error(`procore: the punch list for project ${pid} is longer than ${MAX_PUNCH_PAGES} pages; refused whole`);
  },
  /** Procore's punch item is itself the task, so nothing is created. */
  async createTask() { return undefined; },
  /** Sign-off happens inside Procore (the item's final approver), so there is no client email address here. */
  async clientContact() { return {}; },
  /** Queue one comment on a punch item for a person to approve. The key makes a repeat run queue nothing new. */
  async queueReminder(ctx, a) {
    const text = clean(a.text, 2000);
    return ctx.queue({ platform: P, op: OP.comment, key: a.key, summary: a.summary,
      input: { params: { id: num(a.item), project_id: num(a.project) }, body: { comment: { body: text } } } }, a.summary);
  },
};
