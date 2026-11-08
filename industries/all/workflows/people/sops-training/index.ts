// The SOP and training workflow's three crons. Each one reads, drafts and queues; none sends or publishes.
// Judgment (reading a source, writing the SOP outline into the proposals namespace) belongs to the agent skill in
// SKILL.md. The crons turn an outline into a draft page, and turn a published SOP into training for each trainee.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { type Proposal, type Settings, type Source, type Sop, type Training, EMAIL, checkProposal, keyOf, sopHtml, sopTitle, taskNotes, trainingHtml } from "./types.ts";
import { confluence } from "./adapters/confluence.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";
import { asana } from "./adapters/asana.ts";

const SOURCES = { confluence: confluence.sources, "microsoft-365": microsoft365.sources } as const;

/** Every 30 minutes: new know-how pages and walkthrough emails, each one stored once as a source. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.know_how ?? []) {
    const read = SOURCES[p];
    if (!read) throw new Error(`sops-training: no source reader for ${p}`);
    for (const s of await read(ctx)) {
      if (await ctx.store.get("sources", s.id)) continue;
      await ctx.store.put("sources", s.id, { ...s, status: "new" } satisfies Source);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: a source with an outline becomes a draft SOP page, and its publish waits for approval.
 *  A source without a usable outline is parked as needs-writing until the agent writes one. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Source>("sources")).filter((s) => s.status === "new" || s.status === "needs-writing");
  let drafted = 0, needs_writing = 0;
  for (const s of todo) {
    const got = await ctx.store.get<Proposal>("proposals", s.id);
    const prop = got ? checkProposal(got) : "no SOP outline yet: the agent writes one from the source";
    if (typeof prop === "string") {
      needs_writing++;
      await ctx.store.put("sources", s.id, { ...s, status: "needs-writing", reason: prop });
      continue;
    }
    const title = sopTitle(prop.title), html = sopHtml(prop);
    const page = await confluence.draftPage(ctx, title, html);
    const approval = await ctx.queue({ ...confluence.publishAct({ ...page, title, html }), key: `publish:${s.id}` });
    const sop: Sop = { title, purpose: prop.purpose, steps: prop.steps, page: page.page, version: page.version, approval };
    await ctx.store.put("sources", s.id, { ...s, status: "drafted", reason: undefined, sop } satisfies Source);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${needs_writing} need an outline`);
  return { drafted, needs_writing };
}

/** Hourly: a source whose SOP publish was approved is published; each trainee gets one Asana task and one training
 *  email, drafted and queued as a single approval (assign the task, then send the email). Never twice for one trainee. */
export async function train(ctx: Ctx<Settings>) {
  let published = 0;
  for (const s of Object.values(await ctx.store.list<Source>("sources"))) {
    if (s.status !== "drafted" || !s.sop) continue;
    const ap = await ctx.store.get<Approval>("approvals", s.sop.approval);
    if (ap?.status === "done") { await ctx.store.put("sources", s.id, { ...s, status: "published" } satisfies Source); published++; }
  }
  let queued = 0, no_address = 0;
  for (const s of Object.values(await ctx.store.list<Source>("sources"))) {
    if (s.status !== "published" || !s.sop) continue;
    for (const t of ctx.settings.trainees ?? []) {
      if (!EMAIL.test(t.email)) { no_address++; continue; }
      const key = keyOf(`${s.id}:${t.email.toLowerCase()}`);
      let rec = await ctx.store.get<Training>("training", key);
      if (rec?.approval) continue;   // already queued: a cron that runs again never queues it twice
      if (!rec) {
        const task = await asana.createTask(ctx, `Read ${s.sop.title}`.slice(0, 250), taskNotes(s.sop));
        rec = { key, sop: s.id, trainee: t.email, task };
        await ctx.store.put("training", key, rec);   // kept before the email is drafted, so a retry reuses the task
      }
      const m = trainingHtml(ctx.settings, t, s.sop);
      const d = await microsoft365.mailDraft(ctx, { to: t.email, subject: m.subject, html: m.html });
      const approval = await ctx.queue([{ ...asana.assignAct(rec.task, t.email), key: `train:${key}` }, d.act],
        `assign "Read ${s.sop.title}" to ${t.email} and send the training email`);
      await ctx.store.put("training", key, { ...rec, approval } satisfies Training);
      queued++;
    }
  }
  ctx.log(`train: ${published} published, ${queued} trainee approvals queued, ${no_address} without a usable address`);
  return { published, queued, no_address };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, train };
