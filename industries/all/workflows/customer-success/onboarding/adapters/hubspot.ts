// HubSpot: the client's contact record (an internal CRM record, a draft operation), a read of the payment setup, and team
// invitations. An invitation emails the invitee, so it is only ever queued for approval.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Client, type Invite, EMAIL, HSID, HSREF, clean } from "../types.ts";

const P = "hubspot";
export const CONTACT = "crm-contacts-2026-09.post-/crm/objects/2026-09/contacts_/crm/objects/2026-09-beta/{objectType}";
export const PAYMENTS = "commerce-paymentsaccounts-2026-09.get-/commerce/payment-accounts/2026-09/status";
export const INVITE = "settings-user-provisioning-2026-09.post-/settings/users/2026-09";

export const hubspot = {
  id: P,
  /** One contact record for the client. Returns its HubSpot id. */
  async contact(ctx: Ctx<Settings>, c: Client): Promise<string> {
    const properties: Record<string, string> = { company: clean(c.company ?? c.name, 200), firstname: clean(c.name, 120) };
    if (c.email) properties.email = c.email;
    const r = await ctx.draft<any>({ platform: P, op: CONTACT, summary: `create contact record for ${clean(c.name, 80)}`,
      input: { body: { properties, associations: [] } } });
    const id = String(r.data?.id ?? "");
    if (!HSID.test(id)) throw new Error("hubspot: contact not created");
    return id;
  },
  /** Reads the payment setup so the owner can see whether it is ready. The answer is not written anywhere. */
  async paymentsStatus(ctx: Ctx<Settings>): Promise<void> {
    await ctx.draft({ platform: P, op: PAYMENTS, summary: "read payment setup" });
  },
  /** An invitation to the client's team. It emails the invitee, so it is queued, never sent by a cron. */
  queueInvite(ctx: Ctx<Settings>, clientKey: string, inv: Invite): Promise<string> {
    if (!EMAIL.test(inv.email)) throw new Error("hubspot: bad invitation email");
    if (inv.roleId && !HSREF.test(inv.roleId)) throw new Error("hubspot: bad roleId");
    if (inv.primaryTeamId && !HSREF.test(inv.primaryTeamId)) throw new Error("hubspot: bad primaryTeamId");
    const body = {
      email: inv.email, sendWelcomeEmail: true,
      ...(inv.firstName ? { firstName: clean(inv.firstName, 100) } : {}),
      ...(inv.lastName ? { lastName: clean(inv.lastName, 100) } : {}),
      ...(inv.roleId ? { roleId: inv.roleId } : {}),
      ...(inv.primaryTeamId ? { primaryTeamId: inv.primaryTeamId } : {}),
    };
    const summary = `Invite ${inv.email} to the HubSpot team`;
    return ctx.queue({ platform: P, op: INVITE, key: safeKey(`invite:${clientKey}:${inv.email}`), summary, input: { body } }, summary);
  },
};
