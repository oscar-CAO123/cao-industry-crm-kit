// Rex: the property and contact lists a condition report starts from. Reads only. Rex is an RPC API: every call is a POST to
// https://{host}/v1/rex/<service>/<method> (api-docs.rexsoftware.com, read 11 Nov 2026). A search takes limit and offset in the body and
// answers { result: { rows: [...], total }, error }; each row carries id. Property rows carry system_search_key (the address
// line); contact rows carry name and email_address. Rex has no condition-report service, so nothing is written.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "rex";
export const MAX_PAGES = 50;
const LIMIT = 50;
const ID = /^[1-9]\d{0,11}$/;
export const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** Every row of a search, paged by offset until an empty page. A non-list reply, a Rex error, a row with no usable id, or a list past MAX_PAGES is refused whole. */
async function searchAll(ctx: Ctx<Settings>, service: string): Promise<any[]> {
  const out: any[] = [], seen = new Set<string>();
  let received = 0;   // rows Rex has returned so far: the next offset, so a server that caps the page size below LIMIT is never skipped over
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: `${service}.search`, summary: `read ${service}, page ${page + 1}`, input: { params: { limit: LIMIT, offset: received } } });
    if (r.data?.error) throw new Error(`rex: ${service} search returned an error`);
    const rows = r.data?.result?.rows;
    if (!Array.isArray(rows)) throw new Error(`rex: the ${service} search did not come back as a list`);
    if (rows.length === 0) {
      // The total Rex reports is checked at the end: a list that came back short is a failed read, never a smaller list.
      const total = Number(r.data?.result?.total);
      if (Number.isFinite(total) && received < total) throw new Error(`rex: the ${service} list came back short (${received} of ${total}); refused whole`);
      return out;
    }
    received += rows.length;
    for (const x of rows) {
      const id = String(x?.id ?? "");
      if (!ID.test(id)) throw new Error(`rex: a ${service} row came back with no usable id; the list is refused whole`);
      if (!seen.has(id)) { seen.add(id); out.push(x); }
    }
  }
  throw new Error(`rex: the ${service} list is longer than ${MAX_PAGES} pages; refused whole`);
}

export const rex = {
  async properties(ctx: Ctx<Settings>): Promise<{ id: string; address?: string }[]> {
    return (await searchAll(ctx, "properties")).filter((x) => String(x.system_record_state ?? "active") === "active").map((x) => ({ id: String(x.id), address: clean(x.system_search_key, 200) || undefined }));
  },
  async contacts(ctx: Ctx<Settings>): Promise<{ id: string; name: string }[]> {
    return (await searchAll(ctx, "contacts")).filter((x) => String(x.system_record_state ?? "active") === "active").map((x) => ({ id: String(x.id), name: clean(x.name, 120) }));
  },
};
