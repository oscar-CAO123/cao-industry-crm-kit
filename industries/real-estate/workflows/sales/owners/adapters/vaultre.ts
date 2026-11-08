// VaultRE: the current owners list, owner details and GDPR consent records. Reads only: every call here is a draft operation.
// Field names come from the vendor's spec (endpoint-map/raw/vaultre: Contact, GdprOptin, currentOwners).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Consent, Contact, Settings } from "../types.ts";

export const P = "vaultre";
const MAX_PAGES = 5;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Vendor text is data: control characters out, length capped. */
export const text = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** A VaultRE contact id is a positive integer. It is checked before it becomes a path value. */
export function contactId(v: unknown): number {
  const s = String(v ?? "");
  if (!/^[1-9]\d{0,17}$/.test(s)) throw new Error("vaultre: bad contact id");
  return Number(s);
}

/** Ids on the current owners list. Walks up to MAX_PAGES pages of 50, stopping at the last page. */
export async function currentOwnerIds(ctx: Ctx<Settings>): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "getCurrentOwners", summary: `read current owners page ${page}`, input: { params: { page, pagesize: 50 } } });
    if (r.status >= 300) throw new Error(`vaultre: current owners returned ${r.status}`);
    for (const row of Array.isArray(r.data?.items) ? r.data.items : []) {
      try { ids.push(String(contactId(row?.contact?.id))); } catch { /* a malformed row is skipped */ }
    }
    const total = Number(r.data?.totalPages ?? 1);
    if (!Number.isFinite(total) || page >= total) break;
  }
  return [...new Set(ids)];
}

/** One owner contact by id. */
export async function getContact(ctx: Ctx<Settings>, id: string): Promise<Contact | undefined> {
  const cid = contactId(id);
  const r = await ctx.draft<any>({ platform: P, op: "getContact", summary: `read owner ${cid}`, input: { params: { id: cid } } });
  if (r.status >= 300) throw new Error(`vaultre: read owner ${cid} returned ${r.status}`);
  const c = r.data;
  if (!c || typeof c !== "object" || Number(c.id) !== cid) return undefined;
  return c as Contact;
}

/** The newest GDPR consent record for the owner. No record at all means no consent. */
export async function consentOf(ctx: Ctx<Settings>, id: string): Promise<Consent> {
  const cid = contactId(id);
  const r = await ctx.draft<any>({ platform: P, op: "getContactGdprOptins", summary: `read consent record for owner ${cid}`, input: { params: { contactid: cid, pagesize: 10 } } });
  if (r.status >= 300) throw new Error(`vaultre: consent for owner ${cid} returned ${r.status}`);
  const when = (x: any) => Date.parse(String(x?.modified ?? x?.inserted ?? "")) || 0;
  const rows: any[] = Array.isArray(r.data?.items) ? r.data.items : [];
  const latest = [...rows].sort((a, b) => when(b) - when(a))[0];
  if (!latest) return { email: false, sms: false, phone: false };
  return { email: latest.email === true, sms: latest.sms === true, phone: latest.phone === true, recorded: String(latest.modified ?? latest.inserted ?? "") || undefined };
}

export const ownerName = (c: Contact) => text(c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" "), 120);
export const ownerEmail = (c: Contact) => { const e = text(c.emails?.[0], 190); return EMAIL.test(e) ? e : undefined; };
export const ownerMobile = (c: Contact) => text(c.phoneNumbers?.find((p) => p.type === "Mobile")?.number, 30) || undefined;
