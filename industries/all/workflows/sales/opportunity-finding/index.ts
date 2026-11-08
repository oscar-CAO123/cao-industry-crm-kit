// The opportunity-finding workflow's three crons. Each reads or drafts; only the digest queues anything, and the queued
// item is the one send, which a person approves. Judgment (does this tender or grant fit the business?) belongs to the
// agent skill in SKILL.md, which writes a verdict into the store's "fit" namespace. Nothing here sends.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Opportunity, type Settings, type Verdict, cell, day, esc } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

/** Hourly: read the alert emails and store the ones not seen before. */
export async function scan(ctx: Ctx<Settings>) {
  let added = 0;
  for (const o of await microsoft365.alerts(ctx)) {
    if (await ctx.store.get("opportunities", o.key)) continue;
    await ctx.store.put("opportunities", o.key, { ...o, status: "new" } satisfies Opportunity);
    added++;
  }
  ctx.log(`scan: ${added} new`);
  return { added };
}

/** Twenty past each hour: one register row per new opportunity, in one write. */
export async function logOpportunities(ctx: Ctx<Settings>) {
  if (!ctx.settings.microsoft_365.register) { ctx.log("log: no register set"); return { logged: 0 }; }
  const news = Object.values(await ctx.store.list<Opportunity>("opportunities")).filter((o) => o.status === "new").slice(0, 50);
  if (!news.length) return { logged: 0 };
  const now = ctx.now.toISOString();
  await microsoft365.logRows(ctx, news.map((o) => [day(ctx.now), cell(o.key), cell(o.title), cell(o.from ?? ""), cell(o.received), "To review"]));
  for (const o of news) await ctx.store.put("opportunities", o.key, { ...o, status: "logged", logged: now });
  ctx.log(`log: ${news.length} logged`);
  return { logged: news.length };
}

/** Each morning (21:00 UTC, 7 or 8 am in eastern Australia): draft the digest of logged opportunities judged a fit, and queue its send. */
export async function digest(ctx: Ctx<Settings>) {
  const all = Object.values(await ctx.store.list<Opportunity>("opportunities"));
  const verdicts = await ctx.store.list<Verdict>("fit");
  const logged = all.filter((o) => o.status === "logged");
  for (const o of logged.filter((x) => verdicts[x.key]?.verdict === "no")) await ctx.store.put("opportunities", o.key, { ...o, status: "dismissed" });
  const pick = logged.filter((o) => { const v = verdicts[o.key]; return v?.verdict === "fits" || v?.verdict === "maybe"; }).slice(0, 50);
  const waiting = logged.filter((o) => !verdicts[o.key]).length;
  if (!pick.length) { ctx.log(`digest: nothing to send, ${waiting} waiting for a fit check`); return { digested: 0, waiting }; }
  const key = `digest:${day(ctx.now)}`;
  // One digest a day: if today's is already queued, leave these for tomorrow rather than drafting a second email.
  if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) { ctx.log("digest: today's digest is already queued"); return { digested: 0, waiting }; }
  const items = pick.map((o) => {
    const v = verdicts[o.key]!;
    return `<li><b>${esc(o.title)}</b> (${esc(v.verdict)}): ${esc(String(v.reason).slice(0, 300))}${o.from ? ` <i>from ${esc(o.from)}</i>` : ""}</li>`;
  }).join("");
  const html = `<p>Opportunities to look at${ctx.settings.business_name ? ` for ${esc(ctx.settings.business_name)}` : ""}:</p><ul>${items}</ul>`
    + (waiting ? `<p>${esc(waiting)} more are waiting for a fit check.</p>` : "");
  const d = await microsoft365.mailDraft(ctx, { to: ctx.settings.digest_to, subject: `Opportunities to review: ${pick.length} (${day(ctx.now)})`, html });
  await ctx.queue({ ...d.act, key }, `Send opportunity digest to ${ctx.settings.digest_to}: ${pick.length} items`);
  for (const o of pick) await ctx.store.put("opportunities", o.key, { ...o, status: "digested", digested: ctx.now.toISOString() });
  ctx.log(`digest: ${pick.length} queued for approval, ${waiting} waiting`);
  return { digested: pick.length, waiting };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, log: logOpportunities, digest };
