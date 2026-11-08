// Re-Leased: approved invoices with money owing, read fresh before any reminder goes out. Read only.
// Field names come from the vendor spec (Re-Leased swagger, definitions Invoice, CompactContact, PropertyModel): Id, DisplayId, Status, DueDate, AmountDue, Contact.Email, Property.Address.
// The spec's list example and its schema disagree on whether Data is one invoice or an array, so both shapes are accepted.
// Re-Leased does not name the tenancy on an invoice in the spec, so a payment plan or collector on the tenancy is not visible here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Arrear, EMAIL, ID } from "../types.ts";

const P = "re-leased";
const text = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const date = (v: unknown) => { const s = String(v ?? ""); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("re-leased: bad id"); return s; };
const items = (d: any): any[] => (Array.isArray(d) ? d : d ? [d] : []);

/** An authorised invoice with money owing and a due date already passed, or null. */
function arrear(inv: any, today: string): Arrear | null {
  const due = date(inv?.DueDate), amount = Number(inv?.AmountDue);
  if (inv?.Status !== "AUTHORISED" || !due || due >= today || !(amount > 0)) return null;
  const c = inv.Contact ?? {};
  const email = typeof c.Email === "string" && EMAIL.test(c.Email) ? c.Email : null;
  return {
    id: uuid(inv.Id), display: text(inv.DisplayId, 40), property: text(inv.Property?.Address, 200),
    contact: text(c.Name, 200), first: text(c.FirstName, 100), email, due, amount: Math.round(amount * 100) / 100,
  };
}

export const reLeased = {
  id: P,
  /** Every page of authorised invoices, filtered to the ones overdue today. Paged by the fromId cursor. */
  async overdue(ctx: Ctx<Settings>, today: string): Promise<Arrear[]> {
    const max = Math.min(ctx.settings.max_pages ?? 5, 50);
    const out: Arrear[] = [];
    let from: string | undefined;
    for (let page = 1; page <= max; page++) {
      const params: Record<string, string> = { status: "AUTHORISED" };
      if (from) params.fromId = from;
      const r = await ctx.draft<any>({ platform: P, op: "Invoices_Get", summary: `invoices page ${page}`, input: { params } });
      const list = items(r.data?.Data);
      for (const inv of list) { const a = arrear(inv, today); if (a) out.push(a); }
      if (!list.length) break;
      from = uuid(list[list.length - 1].Id);
    }
    return out;
  },
  /** One invoice, read again just before a reminder: null when it is paid or no longer owing. */
  async invoice(ctx: Ctx<Settings>, id: string, today: string): Promise<Arrear | null> {
    const r = await ctx.draft<any>({ platform: P, op: "Invoices_Get.get", summary: `invoice ${id}`, input: { params: { id: uuid(id) } } });
    const inv = Array.isArray(r.data?.Data) ? r.data.Data[0] : (r.data?.Data ?? r.data);
    return inv ? arrear(inv, today) : null;
  },
};
