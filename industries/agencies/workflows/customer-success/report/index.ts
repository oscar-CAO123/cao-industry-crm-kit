// The client report workflow's two crons. Each is deterministic: it reads, drafts and queues; it never sends.
// The commentary (what the numbers mean for the client) is judgment and is written into the store before the draft cron
// will build a report. The send waits in the approval queue.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Client, type Commentary, type Pack, type Pull, type Settings, checkClient, esc, keyOf, periodOf } from "./types.ts";
import { supermetrics } from "./adapters/supermetrics.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";

/** Daily: read last month's numbers for each client. Reads only; a client already pulled for the month is skipped. */
export async function pull(ctx: Ctx<Settings>) {
  const p = periodOf(ctx.now);
  let pulled = 0;
  const errors: string[] = [];
  for (const c of ctx.settings.clients ?? []) {
    const key = keyOf(`${c.name}:${p.key}`);
    if (await ctx.store.get("pulls", key)) continue;
    try {
      checkClient(c);
      const rows = await supermetrics.pull(ctx, c, p);
      await ctx.store.put("pulls", key, { key, client: c.name, period: p.key, rows, pulled: ctx.now.toISOString() } satisfies Pull);
      pulled++;
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  ctx.log(`pull: ${pulled} pulled, ${errors.length} failed`);
  return { pulled, errors };
}

const table = (rows: string[][]) => {
  const [head = [], ...body] = rows;
  const th = `<tr>${head.map((h) => `<th align="left">${esc(h)}</th>`).join("")}</tr>`;
  const tr = body.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("");
  return `<table cellpadding="4">${th}${tr}</table>`;
};
const paragraphs = (text: string) => text.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("");

/** The report as escaped HTML: the commentary, then the numbers. */
function packHtml(s: Settings, c: Client, pl: Pull, text: string): string {
  return `<p>Hi ${esc(c.contact_name ?? "there")},</p>${paragraphs(text)}<h3>${esc(pl.period)} numbers</h3>${table(pl.rows)}`
    + `<p>Sent by ${esc(s.business_name ?? "us")}.</p>`;
}

/** Daily: for each pulled client with commentary written, draft the report in Gmail and queue its send for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const p = periodOf(ctx.now);
  const pulls = Object.values(await ctx.store.list<Pull>("pulls")).filter((x) => x.period === p.key);
  let drafted = 0, waiting = 0;
  const errors: string[] = [];
  for (const pl of pulls) {
    const key = keyOf(`${pl.client}:${pl.period}`);
    const c = (ctx.settings.clients ?? []).find((x) => x.name === pl.client);
    if (!c || (await ctx.store.get("packs", key))) continue;   // already drafted: a cron that runs again never drafts twice
    const note = await ctx.store.get<Commentary>("commentary", key);
    if (!note?.text?.trim()) { waiting++; continue; }
    try {
      const subject = `${c.name}: ${pl.period} performance report`;
      const draftId = await googleWorkspace.draftReport(ctx, c.contact_email, subject, packHtml(ctx.settings, c, pl, note.text));
      await ctx.store.put("packs", key, { key, client: c.name, period: pl.period, draft_id: draftId, queued: ctx.now.toISOString() } satisfies Pack);
      await ctx.queue(googleWorkspace.sendAct(draftId, c.contact_email, `send:${key}`), `Send ${c.name} ${pl.period} report to ${c.contact_email}`);
      drafted++;
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  ctx.log(`draft: ${drafted} drafted, ${waiting} waiting for commentary, ${errors.length} failed`);
  return { drafted, waiting_for_commentary: waiting, errors };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, draft };
