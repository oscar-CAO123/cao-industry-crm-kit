// Smokeball: the matter and contact records. Field names come from the vendor spec (docs.smokeball.com openapi):
// Matter (id, title, isLead, clients, otherSides), Role (id, contact, isClient, isOtherSide),
// Relationship (contact), Contact (person, company, trust, groupOfPeople), PatchMatter body (isLead).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Hit, Lead, Party, Settings } from "../types.ts";
import { clean } from "../types.ts";

const P = "smokeball";
/** Smokeball ids are GUIDs: anything else never reaches a path. */
const ID = /^[A-Za-z0-9-]{1,80}$/;
const id = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("smokeball: bad id"); return s; };

/** A contact's display name, whichever kind of contact it is. */
export function displayName(c: any): string {
  if (c?.person) return clean([c.person.firstName, c.person.lastName].filter(Boolean).join(" "));
  return clean(c?.company?.name ?? c?.trust?.name ?? c?.groupOfPeople?.name ?? c?.name ?? "");
}

/** Leads (matters not yet opened) from the practice system. */
export async function newLeads(ctx: Ctx<Settings>): Promise<Pick<Lead, "id" | "title" | "created">[]> {
  const r = await ctx.draft<any>({ platform: P, op: "GetMatters", summary: "read new leads",
    input: { params: { IsLead: true, Limit: 50 } } });
  return (r.data?.value ?? []).map((m: any) => ({
    id: id(m.id), title: clean(m.title || m.number || "Lead"), created: clean(m.leadOpenedDate ?? "", 40),
  }));
}

/** The parties on a lead: each role's contact, and the contacts related to each role. */
export async function partiesOf(ctx: Ctx<Settings>, matterId: string): Promise<Party[]> {
  const mid = id(matterId);
  const roles = await ctx.draft<any>({ platform: P, op: "GetRolesOnMatter", summary: "read parties on a lead",
    input: { params: { matterId: mid } } });
  const out: Party[] = [];
  for (const role of roles.data?.roles ?? []) {
    const kind: Party["role"] = role.isClient ? "client" : role.isOtherSide ? "other-side" : "related";
    if (role.contact?.id) {
      const c = await ctx.draft<any>({ platform: P, op: "GetContactById", summary: "read a party",
        input: { params: { id: id(role.contact.id) } } });
      out.push({ name: displayName(c.data), contact_id: id(role.contact.id), role: kind });
    }
    if (!role.id) continue;
    const rel = await ctx.draft<any>({ platform: P, op: "GetRelationshipsOnRole", summary: "read related parties",
      input: { params: { matterId: mid, roleId: id(role.id) } } });
    for (const r of rel.data?.relationships ?? []) {
      if (!r.contact?.id) continue;
      const c = await ctx.draft<any>({ platform: P, op: "GetContactById", summary: "read a related party",
        input: { params: { id: id(r.contact.id) } } });
      out.push({ name: displayName(c.data), contact_id: id(r.contact.id), role: "related" });
    }
  }
  return out.filter((p) => p.name.length > 1);
}

/** Contacts whose name matches a party, other than the lead's own parties. Read only. */
export async function nameMatches(ctx: Ctx<Settings>, party: Party, own: Set<string>): Promise<Hit[]> {
  const r = await ctx.draft<any>({ platform: P, op: "GetContacts", summary: `search contacts for ${party.name}`,
    input: { params: { Search: clean(party.name, 80), Limit: ctx.settings.search_limit ?? 20 } } });
  return (r.data?.value ?? [])
    .map((c: any) => ({ party: party.name, contact_id: id(c.id), name: displayName(c) }))
    .filter((h: Hit) => !own.has(h.contact_id));
}

/** The live operation: a lead becomes a matter. Only ever queued for approval. */
export const openLead = (matterId: string) => ({
  platform: P, op: "PatchMatter", summary: `open lead ${id(matterId)} as a matter`,
  input: { params: { matterId: id(matterId) }, body: { isLead: false } },
});
