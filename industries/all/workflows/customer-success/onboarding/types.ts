// Shared shapes for the onboarding workflow. Two platforms carry it: Google Workspace (the client's checklist, and the
// welcome email as a Gmail draft) and HubSpot (the client's contact record, and team invitations).
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace" | "hubspot";

export interface Invite { email: string; firstName?: string; lastName?: string; roleId?: string; primaryTeamId?: string }
export interface Client { id: string; name: string; company?: string; email?: string; invite?: Invite[] }
export interface Settings {
  business_name?: string;
  owner_email?: string;                                  // where the progress note is drafted (internal)
  checklist: string[];                                   // one Google Tasks item per step, in order
  clients: Client[];
  welcome?: { subject?: string; body?: string };         // plain text; {name} and {business} are filled in
}
/** What the workflow knows about one client, kept in the store under the client's key. */
export interface Rec {
  client: string;
  stage: "new" | "set-up" | "welcome-queued" | "complete";
  hubspot_contact?: string;
  checklist_list?: string;
  checklist_added?: number;                              // steps already added, so a retry adds only the rest
  payments_checked?: string;
  welcome_draft?: string;
  welcome_approval?: string;
  progress?: { done: number; open: number; checked: string };
  owner_note_open?: number;                              // the open count last drafted to the owner
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GID = /^[A-Za-z0-9=_-]{1,200}$/;            // Google Tasks list and task ids, Gmail draft ids
export const HSID = /^[0-9]{1,20}$/;                     // HubSpot record ids
export const HSREF = /^[A-Za-z0-9_-]{1,64}$/;            // HubSpot role and team ids
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,60}$/i;

/** One line of plain text: no line breaks, no control characters, capped. Client and vendor text is data. */
export const clean = (s: unknown, max = 200) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** Plain-text body: line breaks kept, control characters removed. */
export const bodyText = (t: string) => t.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 8000);
export const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

/** Every client in settings, checked before any network call. A bad entry stops the run: nothing is guessed. */
export function clientsOf(s: Settings): { key: string; client: Client }[] {
  if (!Array.isArray(s.clients)) throw new Error("onboarding: clients must be a list");
  if (!Array.isArray(s.checklist) || s.checklist.length > 50) throw new Error("onboarding: checklist must be a list of up to 50 steps");
  for (const step of s.checklist) if (!clean(step, 200)) throw new Error("onboarding: a checklist step is empty");
  const seen = new Set<string>();
  return s.clients.map((c) => {
    if (!CLIENT_ID.test(String(c.id ?? ""))) throw new Error("onboarding: a client id must be letters, digits and dashes");
    if (seen.has(c.id)) throw new Error(`onboarding: client id ${c.id} is listed twice`);
    seen.add(c.id);
    if (!clean(c.name, 120)) throw new Error(`onboarding: client ${c.id} needs a name`);
    if (c.email && !EMAIL.test(c.email)) throw new Error(`onboarding: client ${c.id} has a bad email`);
    for (const i of c.invite ?? []) {
      if (!EMAIL.test(String(i.email ?? ""))) throw new Error(`onboarding: client ${c.id} has an invitation with a bad email`);
      if (i.roleId && !HSREF.test(i.roleId)) throw new Error(`onboarding: client ${c.id} has a bad roleId`);
      if (i.primaryTeamId && !HSREF.test(i.primaryTeamId)) throw new Error(`onboarding: client ${c.id} has a bad primaryTeamId`);
    }
    return { key: safeKey(`client:${c.id}`), client: c };
  });
}

export type { Ctx };
