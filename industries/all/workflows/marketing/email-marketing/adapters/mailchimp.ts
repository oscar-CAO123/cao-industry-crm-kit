// Mailchimp: newsletters as campaigns and automated email flows. A campaign saved in draft state reaches nobody, so
// creating it and setting its content may run from a cron. A schedule, a start or a pause reaches subscribers, so
// each is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, LIST, EMAIL, line, type Newsletter, type Settings } from "../types.ts";

const P = "mailchimp";
export const OP = {
  reports: "core.reports_list",
  automations: "core.automations_list",
  automationEmails: "core.automations_list-emails",
  createCampaign: "core.campaigns_create",
  setContent: "core.campaigns_upsert-content",
  schedule: "core.campaigns_create-action-schedule",
  startEmail: "core.automations_create-email-action-start",
  pauseEmail: "core.automations_create-email-action-pause",
} as const;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const since = (now: Date, days: number) => new Date(now.getTime() - days * 864e5).toISOString();
const idOf = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("mailchimp: an id in the reply is malformed"); return s; };

/** Results of recent sends: open and click rates as Mailchimp reports them (decimals, 0.25 is 25 percent). */
export async function reports(ctx: Ctx<Settings>) {
  const r = await ctx.draft<any>({ platform: P, op: OP.reports, summary: "recent campaign reports", input: { params: { since_send_time: since(ctx.now, 30), count: 50 } } });
  return (r.data?.reports ?? []).map((x: any) => ({
    id: String(x.id ?? ""), title: line(x.campaign_title), subject: line(x.subject_line), send_time: String(x.send_time ?? ""),
    emails_sent: num(x.emails_sent) ?? 0, open_rate: num(x.opens?.open_rate), click_rate: num(x.clicks?.click_rate),
  })).filter((x: any) => ID.test(x.id));
}

/** Automated flows and their emails, each with its status. */
export async function automations(ctx: Ctx<Settings>) {
  const r = await ctx.draft<any>({ platform: P, op: OP.automations, summary: "automations", input: { params: { count: 50 } } });
  const out = [];
  for (const a of r.data?.automations ?? []) {
    const id = String(a.id ?? "");
    if (!ID.test(id)) continue;
    const e = await ctx.draft<any>({ platform: P, op: OP.automationEmails, summary: "automation emails", input: { params: { workflow_id: id } } });
    out.push({
      id, title: line(a.settings?.title), status: line(a.status, 40),
      emails: (e.data?.emails ?? []).filter((m: any) => ID.test(String(m.id ?? ""))).map((m: any) => ({
        id: String(m.id), status: line(m.status, 40), subject: line(m.settings?.subject_line),
      })),
    });
  }
  return out;
}

/** Create the newsletter as a draft campaign (Mailchimp's save state, not sent). Returns the campaign id. */
export async function createCampaign(ctx: Ctx<Settings>, key: string, n: Newsletter): Promise<string> {
  const m = ctx.settings.mailchimp!;
  if (!LIST.test(m.list_id) || !EMAIL.test(m.reply_to)) throw new Error("mailchimp: settings are malformed");
  const r = await ctx.draft<any>({ platform: P, op: OP.createCampaign, summary: `create draft campaign ${key}`, input: { body: {
    type: "regular",
    recipients: { list_id: m.list_id },
    settings: { title: key.slice(0, 100), subject_line: n.subject, preview_text: n.preview_text ?? "", from_name: m.from_name, reply_to: m.reply_to },
  } } });
  return idOf(r.data?.id);
}

/** Set the newsletter's html on its draft campaign. Replaces the content each time, so a re-run is safe. */
export async function setContent(ctx: Ctx<Settings>, campaignId: string, html: string) {
  idOf(campaignId);
  await ctx.draft({ platform: P, op: OP.setContent, summary: `set content on draft campaign ${campaignId}`, input: { params: { campaign_id: campaignId }, body: { html } } });
}

/** Queue the scheduled send for approval. The schedule runs only after a person approves it. */
export function queueSchedule(ctx: Ctx<Settings>, key: string, campaignId: string, n: Newsletter) {
  idOf(campaignId);
  const when = new Date(n.schedule_time).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const summary = `Schedule "${line(n.subject, 120)}" to the Mailchimp audience for ${when} (campaign ${campaignId})`;
  return ctx.queue({ platform: P, op: OP.schedule, input: { params: { campaign_id: campaignId }, body: { schedule_time: when } }, summary, key: `newsletter:${key}` }, summary);
}

/** Queue a start or pause of one automated email for approval. */
export function queueFlowEmail(ctx: Ctx<Settings>, key: string, c: { action: "start" | "pause"; workflow_id: string; email_id: string; reason: string }) {
  const summary = `${c.action === "start" ? "Start" : "Pause"} automated email ${c.email_id} in flow ${c.workflow_id}: ${line(c.reason, 120)}`;
  return ctx.queue({ platform: P, op: c.action === "start" ? OP.startEmail : OP.pauseEmail,
    input: { params: { workflow_id: c.workflow_id, workflow_email_id: c.email_id } }, summary, key: `flow:${key}` }, summary);
}
