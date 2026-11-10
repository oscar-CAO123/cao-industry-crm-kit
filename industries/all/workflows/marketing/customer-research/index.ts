// The customer research workflow's three crons. Each reads, drafts or logs internally, and queues. None sends.
// A send is an act queued for a person's approval in the CRM shell. Writing up themes from free-text answers is
// judgment and belongs to the agent skill in SKILL.md; these crons only count and draft.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Response, type Settings, checkSettings, keyFor, esc, firstName, day } from "./types.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";
import { calendly } from "./adapters/calendly.ts";

/** Every 30 minutes: read new survey responses, store each once, and add it to the research log. */
export async function responses(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  checkSettings(s);
  const fresh = s.survey.source === "google-forms"
    ? await googleWorkspace.responses(ctx, s.survey.google_form_id!)
    : await calendly.responses(ctx, s.survey.calendly_form_uri!);
  let added = 0;
  for (const r of fresh) {
    if (await ctx.store.get("responses", r.key)) continue;
    if (s.research_log) await googleWorkspace.logRow(ctx, s.research_log, r); // log first: a crash repeats a row, never loses one
    await ctx.store.put("responses", r.key, r);
    added++;
  }
  ctx.log(`responses: ${added} new`);
  return { added };
}

/** Hourly: draft one invite per chosen customer and queue each send for approval. Re-runs reuse the same draft and approval. */
export async function invite(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  checkSettings(s);
  const name = s.business_name ?? "us";
  const subject = s.invite.subject ?? `A few quick questions from ${name}`;
  let drafted = 0, queued = 0;
  for (const c of s.invite.audience.slice(0, 50)) {
    const k = keyFor("inv", c.email.toLowerCase());
    let rec = await ctx.store.get<{ draft_id: string }>("invites", k);
    if (!rec) {
      const draftId = await googleWorkspace.draftMail(ctx, c.email, subject, inviteHtml(s, c.name));
      rec = { draft_id: draftId };
      await ctx.store.put("invites", k, { draft_id: draftId, created: ctx.now.toISOString() });
      drafted++;
    }
    // queue() returns the existing approval when this key is already queued, so a send is never queued twice.
    await ctx.queue(googleWorkspace.sendAct(rec.draft_id, c.email, `invite-${k}`), `Send survey invite to ${c.email}`);
    queued++;
  }
  ctx.log(`invite: ${drafted} drafted, ${queued} send approvals waiting`);
  return { drafted, waiting: queued };
}

/** Daily: one summary draft to the owner with the answer counts to date. Once per day. */
export async function summarise(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  checkSettings(s);
  const today = day(ctx.now);
  if (await ctx.store.get("summaries", today)) return { drafted: 0 };
  const all = Object.values(await ctx.store.list<Response>("responses"));
  if (!all.length) return { drafted: 0, responses: 0 };
  const counts = new Map<string, Map<string, number>>();
  for (const r of all) for (const a of r.answers) {
    if (!a.answer) continue;
    const q = counts.get(a.question) ?? new Map<string, number>();
    const v = a.answer.slice(0, 120);
    q.set(v, (q.get(v) ?? 0) + 1);
    counts.set(a.question, q);
  }
  const sections = [...counts.entries()].map(([q, m]) =>
    `<h3>${esc(q)}</h3><ul>${[...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)
      .map(([v, n]) => `<li>${esc(v)}: ${esc(n)}</li>`).join("")}</ul>`).join("");
  const html = `<p>${esc(all.length)} responses to date.</p>${sections}<p>Read the free-text answers in the research log before drawing conclusions.</p>`;
  const draftId = await googleWorkspace.draftMail(ctx, s.owner_email, `Customer research summary ${today}`, html);
  await ctx.store.put("summaries", today, { draft_id: draftId, responses: all.length, created: ctx.now.toISOString() });
  ctx.log(`summarise: 1 draft for ${all.length} responses`);
  return { drafted: 1, responses: all.length };
}

export function inviteHtml(s: Settings, name?: string): string {
  const biz = esc(s.business_name ?? "us");
  const hi = firstName(name) ? `Hi ${esc(firstName(name))},` : "Hi there,";
  return `<p>${hi}</p>`
    + `<p>${biz} is asking a few customers for their view on how we work together. It takes about two minutes and three or four questions.</p>`
    + `<p><a href="${esc(s.survey.survey_url)}">Answer the questions</a></p>`
    + `<p>Thanks,<br>${biz}</p>`;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { responses, invite, summarise };
