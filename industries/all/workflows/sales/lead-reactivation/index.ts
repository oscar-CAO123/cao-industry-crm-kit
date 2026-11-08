// The lead reactivation workflow's three crons. Each reads, drafts or queues. None sends: every enrolment or send waits for a person.
// Judgment (who is worth reaching, what the campaign says) belongs to the person, in SKILL.md.
import type { Act, Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Candidate, Settings } from "./types.ts";
import { DAY, candKey, checkSettings, clip } from "./types.ts";
import { lapsedContacts, enrolAct, tagContact, taskContact } from "./adapters/gohighlevel.ts";
import { sendCampaignAct } from "./adapters/klaviyo.ts";

const ENROL = "contacts.add-contact-to-campaign";
const perRun = (s: Settings) => Math.min(Math.max(s.per_run ?? 50, 1), 500);
const batchSize = (s: Settings) => Math.min(Math.max(s.batch ?? 5, 1), 5);
const label = (c: Candidate) => clip(c.email ?? c.id, 80);

/** Every 6 hours (GoHighLevel only): read the lapsed contacts into the reactivation list. Reads only. */
export async function listBuild(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  if (ctx.settings.send !== "gohighlevel") return { skipped: "send is klaviyo: the audience is that campaign's segment" };
  const people = await lapsedContacts(ctx);
  let added = 0;
  for (const p of people) {
    const key = candKey(p.id);
    if (await ctx.store.get<Candidate>("candidates", key)) continue;
    await ctx.store.put("candidates", key, { key, id: p.id, email: p.email, status: "candidate", seen: ctx.now.toISOString() } satisfies Candidate);
    added++;
  }
  ctx.log(`list-build: ${people.length} lapsed, ${added} new`);
  return { lapsed: people.length, added };
}

/** Records enrolments a person has approved: tags each contact with the sent tag once and starts its follow-up clock. */
async function recordApproved(ctx: Ctx<Settings>): Promise<void> {
  const approvals = Object.values(await ctx.store.list<Approval>("approvals")).filter((a) => a.workflow === ctx.workflow.id);
  for (const ap of approvals) {
    for (const [i, act] of ap.acts.entries()) {
      const r = ap.results?.[i];
      if (act.op !== ENROL || !r || typeof r.status !== "number" || r.status >= 300) continue;
      const id = String((act.input?.params as Record<string, unknown> | undefined)?.contactId ?? "");
      const key = candKey(id);
      const c = await ctx.store.get<Candidate>("candidates", key);
      if (!c || c.status !== "queued") continue;
      await tagContact(ctx, id, ctx.settings.sent_tag);
      await ctx.store.put("candidates", key, { ...c, status: "sent", sent_at: ctx.now.toISOString() } satisfies Candidate);
    }
  }
}

/** Every weekday morning: record what was approved, then queue the next enrolments (or the Klaviyo send) for approval. Queues only. */
export async function queueSend(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  if (s.send === "klaviyo") {
    const act = sendCampaignAct(s, `send:klaviyo:${s.klaviyo!.campaign_id}`);
    const approval = await ctx.queue(act, act.summary);
    return { queued_send: approval };
  }
  await recordApproved(ctx);
  const campaign = s.campaign_id!;
  const todo = Object.values(await ctx.store.list<Candidate>("candidates")).filter((c) => c.status === "candidate").slice(0, perRun(s));
  const size = batchSize(s);
  let queued = 0;
  for (let i = 0; i < todo.length; i += size) {
    const chunk = todo.slice(i, i + size);
    const key = `enrol:${campaign}:${chunk.map((c) => c.id).join(",")}`;
    const acts: Act[] = chunk.map((c, j) => enrolAct(campaign, c.id, j === 0 ? key : undefined));
    const approval = await ctx.queue(acts, `Enrol ${chunk.length} in campaign ${campaign}: ${chunk.map(label).join(", ")}`);
    for (const c of chunk) await ctx.store.put("candidates", c.key, { ...c, status: "queued", approval } satisfies Candidate);
    queued += chunk.length;
  }
  ctx.log(`queue-send: ${queued} queued for approval`);
  return { queued };
}

/** Daily (GoHighLevel only): task a person to check on each contact enrolled long enough ago. Drafts a task; never messages anyone. */
export async function followUp(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  if (s.send !== "gohighlevel") return { skipped: "klaviyo sends have no per-contact task" };
  await recordApproved(ctx);
  const days = s.task_after_days ?? 7, now = ctx.now.getTime();
  const due = Object.values(await ctx.store.list<Candidate>("candidates"))
    .filter((c) => c.status === "sent" && c.sent_at && now - Date.parse(c.sent_at) >= days * DAY)
    .slice(0, perRun(s));
  for (const c of due) {
    await taskContact(ctx, c.id, `Reactivation check: ${label(c)}`,
      `Enrolled in the reactivation campaign ${days} days ago. Look for a reply and take it from here.`, ctx.now.toISOString());
    await ctx.store.put("candidates", c.key, { ...c, status: "tasked", tasked_at: ctx.now.toISOString() } satisfies Candidate);
  }
  ctx.log(`follow-up: ${due.length} tasked`);
  return { tasked: due.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "list-build": listBuild, "queue-send": queueSend, "follow-up": followUp };
