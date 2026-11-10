// Rex: the contact list the prospects come from. Reads only. Rex is an RPC API: every call is a POST to https://{host}/v1/rex/<service>/<method>
// (api-docs.rexsoftware.com, read 11 Nov 2026). contacts.search takes limit and offset in the body and answers { result: { rows, total }, error };
// each row carries id (a string), name, email_address, phone_number and system_modtime. contacts.read takes { id } and answers { result }.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, VendorContact } from "../types.ts";

export const P = "rex";
export const MAX_PAGES = 20;
const LIMIT = 50;
const ID = /^[1-9]\d{0,11}$/;
const text = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const asContact = (x: any, id?: string): VendorContact => ({
  id: id ?? String(x.id), forename: text(x.name) || undefined, email: text(x.email_address, 190) || undefined,
  mobilePhone: text(x.phone_number, 30) || undefined, modified: text(x.system_modtime, 40) || undefined,
});

/** Every active contact, paged by offset until an empty page. A non-list reply, a Rex error, a row with no usable id or a list past MAX_PAGES is refused whole. */
export async function listContacts(ctx: Ctx<Settings>): Promise<VendorContact[]> {
  const out: VendorContact[] = [], seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "contacts.search", summary: `read contacts, page ${page + 1}`, input: { params: { limit: LIMIT, offset: page * LIMIT } } });
    if (r.data?.error) throw new Error("rex: the contact search returned an error");
    const rows = r.data?.result?.rows;
    if (!Array.isArray(rows)) throw new Error("rex: the contact search did not come back as a list");
    if (rows.length === 0) return out;
    for (const x of rows) {
      const id = String(x?.id ?? "");
      if (!ID.test(id)) throw new Error("rex: a contact row came back with no usable id; the list is refused whole");
      if (String(x.system_record_state ?? "active") !== "active" || seen.has(id)) continue;
      seen.add(id); out.push(asContact(x));
    }
  }
  throw new Error(`rex: the contact list is longer than ${MAX_PAGES} pages; refused whole`);
}

/** One contact by id. The id is checked before it reaches a body. */
export async function getContact(ctx: Ctx<Settings>, id: unknown): Promise<VendorContact | undefined> {
  const cid = String(id ?? "");
  if (!ID.test(cid)) throw new Error("rex: bad contact id");
  const r = await ctx.draft<any>({ platform: P, op: "contacts.read", summary: `read contact ${cid}`, input: { params: { id: Number(cid) } } });
  if (r.data?.error) throw new Error(`rex: read contact ${cid} returned an error`);
  const x = r.data?.result;
  return x && typeof x === "object" ? asContact(x, cid) : undefined;
}
