// Procore for the variations workflow: change events, tracked and never written. Procore holds the pricing (change items, then the
// prime change order) and the owner's approval itself, so there is no rate card, no client email and no follow-up email here: the cron
// records each change event once and logs the ones still open past a window. Field names come from Procore's own change events page
// (developers.procore.com/reference/rest/v1.1/change-events, read 11 Nov 2026): GET /rest/v1.1/change_events with project_id, page,
// per_page and filters[include_deleted]; each item carries id, number, title, status { name, mapped_to_status }, deleted_at,
// in_recycle_bin, created_at and updated_at. Reading is a draft operation.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "procore";
const OP = "change-events.list-change-events";
export const MAX_PAGES = 20;
const PER_PAGE = 100;

const num = (v: unknown) => { const s = String(v ?? ""); if (!/^[1-9]\d{0,11}$/.test(s)) throw new Error("procore: bad id"); return Number(s); };
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export interface ChangeEvent { id: string; number: string; title: string; status: string; open: boolean; created: string }

export function projects(ctx: Ctx<Settings>): { id: string; name: string }[] {
  return (ctx.settings.procore?.projects ?? []).slice(0, 100).map((p) => ({ id: String(num(p.id)), name: clean(p.name, 200) }));
}

/** Every live change event in a project. Paging runs to an empty page; a project past MAX_PAGES, a 200 that is not a list or a row with no id is refused whole. */
export async function changeEvents(ctx: Ctx<Settings>, project: string): Promise<ChangeEvent[]> {
  const pid = num(project), out = new Map<number, ChangeEvent>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any[]>({ platform: P, op: OP, summary: `change events in project ${pid}, page ${page}`, input: { params: { project_id: pid, page, per_page: PER_PAGE } } });
    if (!Array.isArray(r.data)) throw new Error("procore: the change event list did not come back as a list");
    if (r.data.length === 0) return [...out.values()];
    for (const x of r.data) {
      if (!Number.isInteger(x?.id) || x.id <= 0) throw new Error("procore: a change event came back with no usable id; the list is refused whole");
      if (x.deleted_at || x.in_recycle_bin === true) continue;
      const mapped = clean(x.status?.mapped_to_status, 40), name = clean(x.status?.name, 80);
      out.set(x.id, { id: String(x.id), number: clean(x.number, 40), title: clean(x.title, 160) || "Change event",
        status: mapped || name, open: (mapped || name).toLowerCase() === "open", created: clean(x.created_at, 40) });
    }
  }
  throw new Error(`procore: the change event list for project ${pid} is longer than ${MAX_PAGES} pages; refused whole`);
}
