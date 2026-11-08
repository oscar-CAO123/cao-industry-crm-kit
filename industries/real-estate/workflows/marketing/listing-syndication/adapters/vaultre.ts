// VaultRE: the property record, its photos, the portals the account is connected to, portal enquiries, and the
// internal notes and emails that go with them. Field names come from the vendor's OpenAPI spec (vaultre.yaml).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, int } from "../types.ts";

const P = "vaultre";

export interface Vacancy {
  id: number;
  displayAddress?: string;
  displayPrice?: string;
  heading?: string;
  description?: string;
  bed?: number;
  bath?: number;
  garages?: number;
}
export interface Photo { type?: "Photograph" | "Floorplan"; published?: boolean }
export interface PortalLink { code?: string; description?: string }
export interface EnquiryRow {
  id: number;
  subject?: string;
  body?: string;
  contactId?: number;
  personEmails?: string[];
  personName?: string;
  source?: string;
}

export const vaultre = {
  /** Vacant residential rentals, first page. */
  async vacancies(ctx: Ctx<Settings>): Promise<Vacancy[]> {
    const r = await ctx.draft<{ items?: Vacancy[] }>({ platform: P, op: "getAvailableResidentialLeaseProperties", summary: "read vacant rentals",
      input: { params: { pagesize: 100 } } });
    return (r.data?.items ?? []).filter((p) => p && Number.isSafeInteger(Number(p.id)));
  },
  /** Photos and floor plans on one property. */
  async photos(ctx: Ctx<Settings>, id: number): Promise<Photo[]> {
    const r = await ctx.draft<{ items?: Photo[] }>({ platform: P, op: "getPropertyPhotos", summary: `read photos for ${id}`,
      input: { params: { id: int(id), pagesize: 100 } } });
    return r.data?.items ?? [];
  },
  /** The portals this account publishes to. */
  async portals(ctx: Ctx<Settings>): Promise<PortalLink[]> {
    const r = await ctx.draft<{ items?: PortalLink[] }>({ platform: P, op: "getAccountPortals", summary: "read connected portals",
      input: { params: { pagesize: 100 } } });
    return r.data?.items ?? [];
  },
  /** Enquiries not yet processed in VaultRE, first page. */
  async enquiries(ctx: Ctx<Settings>): Promise<EnquiryRow[]> {
    const r = await ctx.draft<{ items?: EnquiryRow[] }>({ platform: P, op: "getEnquiries", summary: "read unprocessed enquiries",
      input: { params: { processed: false, pagesize: 50 } } });
    return (r.data?.items ?? []).filter((e) => e && Number.isSafeInteger(Number(e.id)));
  },
  /** Internal note on a property. Reaches nobody outside the business. */
  async noteOnProperty(ctx: Ctx<Settings>, id: number, body: string): Promise<void> {
    await ctx.draft({ platform: P, op: "addPropertyNote", summary: `note on property ${id}`,
      input: { params: { id: int(id) }, body: { body } } });
  },
  /** Internal note on a contact. Reaches nobody outside the business. */
  async noteOnContact(ctx: Ctx<Settings>, id: number, body: string): Promise<void> {
    await ctx.draft({ platform: P, op: "addContactNote", summary: `note on contact ${id}`,
      input: { params: { id: int(id) }, body: { body } } });
  },
  /** The reply to an enquirer, as an approval act. Only ctx.queue may run it. */
  replyAct(contactId: number, to: string, subject: string, bodyText: string, key: string): Act {
    return { platform: P, op: "sendContactEmail", key, summary: `reply to enquiry from ${to}: ${subject}`,
      input: { params: { id: int(contactId) }, body: { to, subject, bodyText } } };
  },
};
