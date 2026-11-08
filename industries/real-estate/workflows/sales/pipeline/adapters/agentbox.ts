// AgentBox (Reapit Foundations): the contact list the prospects come from. Reads only: GET /contacts and GET /contact/{id}.
// Field names come from the vendor docs example in endpoint-map/raw/agentbox/pages/api-documentation.md.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, VendorContact } from "../types.ts";

export const P = "agentbox";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;

/** Vendor text is data: control characters out, length capped. */
export const text = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export function contactId(v: unknown): string {
  const s = String(v ?? "");
  if (!ID.test(s)) throw new Error("agentbox: bad contact id");
  return s;
}

function asContact(o: unknown): VendorContact | undefined {
  const c = o as VendorContact | null;
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !ID.test(c.id)) return undefined;
  return c;
}

/** The first page of contacts. The kit maps no paging parameters for this operation, so the default page size applies. */
export async function listContacts(ctx: Ctx<Settings>): Promise<VendorContact[]> {
  const r = await ctx.draft<any>({ platform: P, op: "get:/contacts", summary: "read the first page of contacts" });
  if (r.status >= 300) throw new Error(`agentbox: contact list returned ${r.status}`);
  const items: unknown[] = Array.isArray(r.data?._embedded) ? r.data._embedded : [];
  return items.map(asContact).filter((c): c is VendorContact => !!c);
}

/** One contact by id. The id is checked before it becomes a path value. */
export async function getContact(ctx: Ctx<Settings>, id: unknown): Promise<VendorContact | undefined> {
  const cid = contactId(id);
  const r = await ctx.draft<any>({ platform: P, op: "get:/contact/{id}", summary: `read contact ${cid}`, input: { params: { id: cid } } });
  if (r.status >= 300) throw new Error(`agentbox: read contact ${cid} returned ${r.status}`);
  return asContact(r.data);
}
