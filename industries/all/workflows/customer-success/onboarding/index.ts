// The onboarding workflow's three crons. Each reads and drafts. A team invitation or a welcome email to a client is only
// ever queued: a person approves it in the CRM shell, and only then does it run.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Client, Rec, Settings } from "./types.ts";
import { clientsOf, clean, fill, bodyText, EMAIL } from "./types.ts";
import { google } from "./adapters/google-workspace.ts";
import { hubspot } from "./adapters/hubspot.ts";

const NS = "onboarding";
const day = (d: Date) => d.toISOString().slice(0, 10);
const DEFAULT_BODY = "Hi {name},\n\nWelcome to {business}. We have started setting up your account. You will get an invitation to log in, and we will be in touch with the next steps.\n\nThanks,\n{business}";

async function load(ctx: Ctx<Settings>, key: string, c: Client): Promise<Rec> {
  return (await ctx.store.get<Rec>(NS, key)) ?? { client: c.id, stage: "new" };
}
const save = (ctx: Ctx<Settings>, key: string, r: Rec) => ctx.store.put(NS, key, r);

/** The welcome email for one client, from settings. Plain text, names cleaned to one line. */
export function welcomeText(s: Settings, c: Client): { subject: string; text: string } {
  const vars = { name: clean(c.name, 120), business: clean(s.business_name ?? "our team", 120) };
  return { subject: fill(s.welcome?.subject ?? "Welcome to {business}", vars), text: bodyText(fill(s.welcome?.body ?? DEFAULT_BODY, vars)) };
}

/** Every 30 minutes: for each new client, a contact record, the checklist, a payments read, and the team invitations (queued). */
export async function setup(ctx: Ctx<Settings>) {
  let set = 0, invites = 0;
  for (const { key, client: c } of clientsOf(ctx.settings)) {
    const r = await load(ctx, key, c);
    if (r.stage === "new") {
      if (!r.hubspot_contact) { r.hubspot_contact = await hubspot.contact(ctx, c); await save(ctx, key, r); }
      if (!r.checklist_list) { r.checklist_list = await google.newList(ctx, `${c.name} onboarding`); r.checklist_added = 0; await save(ctx, key, r); }
      for (let i = r.checklist_added ?? 0; i < ctx.settings.checklist.length; i++) {
        await google.addTask(ctx, r.checklist_list, ctx.settings.checklist[i]);
        r.checklist_added = i + 1;
        await save(ctx, key, r);
      }
      if (!r.payments_checked) { await hubspot.paymentsStatus(ctx); r.payments_checked = ctx.now.toISOString(); }
      r.stage = "set-up";
      await save(ctx, key, r);
      set++;
    }
    for (const inv of c.invite ?? []) { await hubspot.queueInvite(ctx, key, inv); invites++; }
  }
  ctx.log(`setup: ${set} set up, ${invites} invitations queued or already waiting`);
  return { set_up: set, invitations: invites };
}

/** Hourly: for each client that is set up, a welcome email drafted in Gmail and its send queued for approval. */
export async function welcome(ctx: Ctx<Settings>) {
  let drafted = 0, queued = 0;
  for (const { key, client: c } of clientsOf(ctx.settings)) {
    const r = await load(ctx, key, c);
    if (r.stage !== "set-up") continue;
    if (!c.email) { ctx.log(`welcome: ${c.id} has no email, skipped`); continue; }
    const { subject, text } = welcomeText(ctx.settings, c);
    if (!r.welcome_draft) { r.welcome_draft = await google.draft(ctx, c.email, subject, text); await save(ctx, key, r); drafted++; }
    r.welcome_approval = await google.queueSend(ctx, r.welcome_draft, `Send the welcome email to ${c.email}: ${clean(subject, 120)}`, `welcome:${key}`);
    r.stage = "welcome-queued";
    await save(ctx, key, r);
    queued++;
  }
  ctx.log(`welcome: ${drafted} drafted, ${queued} queued for approval`);
  return { drafted, queued };
}

/** Daily: read each client's checklist, record progress, and draft an internal note to the owner when the open count changes. */
export async function progress(ctx: Ctx<Settings>) {
  let noted = 0;
  for (const { key, client: c } of clientsOf(ctx.settings)) {
    const r = await load(ctx, key, c);
    if (!r.checklist_list || (r.stage !== "welcome-queued" && r.stage !== "complete")) continue;
    const p = await google.checklist(ctx, r.checklist_list);
    r.progress = { done: p.done, open: p.open, checked: ctx.now.toISOString() };
    if (p.open === 0) r.stage = "complete";
    const owner = ctx.settings.owner_email;
    if (owner && EMAIL.test(owner) && r.owner_note_open !== p.open) {
      const total = p.done + p.open;
      const text = p.open === 0
        ? `${clean(c.name, 120)} has finished onboarding: all ${total} steps are done.`
        : `${clean(c.name, 120)} has ${p.done} of ${total} onboarding steps done, with ${p.open} still open.`;
      await google.draft(ctx, owner, `Onboarding: ${clean(c.name, 80)}`, text);
      r.owner_note_open = p.open;
      noted++;
    }
    await save(ctx, key, r);
  }
  ctx.log(`progress: ${noted} owner notes drafted`);
  return { noted };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { setup, welcome, progress };
