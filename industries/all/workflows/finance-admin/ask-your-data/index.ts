// The ask-your-data workflow's three crons. Each reads or drafts; the owner's answer is only sent after a person approves it.
// Questions come from the owner's own address, and every answer goes back to that address, whatever a question says.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Figure, type FigureSet, type Question, type Settings, type Snapshot, esc } from "./types.ts";
import { xeroRows, type XeroSet } from "./adapters/xero.ts";
import { powerBiRows } from "./adapters/power-bi.ts";
import { numbersPack, questions as readOwnerQuestions, draftAnswer, sendAct } from "./adapters/microsoft-365.ts";

const XERO_SETS: { key: XeroSet; label: string }[] = [
  { key: "profit-and-loss", label: "Profit and loss (Xero)" },
  { key: "balance-sheet", label: "Balance sheet (Xero)" },
  { key: "bank", label: "Bank summary (Xero)" },
  { key: "due-invoices", label: "Invoices awaiting payment (Xero)" },
];

/** Which figure sets a question's words point at. Plain keyword topics, plus any Power BI query whose name a word matches. */
const TOPICS: [RegExp, string[]][] = [
  [/cash|bank|money in|money out/, ["bank", "due-invoices"]],
  [/owe|owing|debt|debtor|receivable|collect|overdue|chase/, ["due-invoices"]],
  [/profit|p&l|margin|loss|make money|makes money|earn/, ["profit-and-loss", "numbers-pack"]],
  [/balance sheet|assets|liabilit|equity/, ["balance-sheet"]],
];
export function pickSets(text: string, snap: Snapshot): FigureSet[] {
  const t = text.toLowerCase(), keys = new Set<string>();
  for (const [re, ks] of TOPICS) if (re.test(t)) ks.forEach((k) => keys.add(k));
  for (const k of Object.keys(snap.sets)) {
    if (k.startsWith("dax:") && k.slice(4).split("-").some((w) => w.length > 3 && t.includes(w))) keys.add(k);
  }
  return [...keys].map((k) => snap.sets[k]).filter((s): s is FigureSet => !!s);
}

/** The answer as an escaped HTML note. It says plainly when no figure set covers the question. */
export function answerHtml(q: Question, snap: Snapshot): { subject: string; html: string; sets: number } {
  const sets = pickSets(`${q.subject} ${q.text}`, snap);
  const parts = [`<p>Hi,</p>`, `<p>Here are the latest figures for "${esc(q.subject)}", as at ${esc(snap.at.slice(0, 10))}.</p>`];
  if (!sets.length) parts.push(`<p>No figure set in this pack covers that question yet. A person will answer it.</p>`);
  for (const s of sets) {
    parts.push(`<h3>${esc(s.label)}</h3>`);
    if (s.error) parts.push(`<p>This could not be read on the last run (${esc(s.error)}).</p>`);
    else if (!s.rows.length) parts.push(`<p>No rows.</p>`);
    else parts.push(`<table cellpadding="4">${s.rows.slice(0, 40).map((r: Figure) => `<tr><td>${esc(r.label)}</td><td align="right">${esc(r.value)}</td></tr>`).join("")}</table>`);
  }
  parts.push(`<p>These figures cover the whole business, not single jobs. Anything they do not show needs a person to answer.</p>`);
  return { subject: `Re: ${q.subject.slice(0, 120)}`, html: parts.join(""), sets: sets.length };
}

/** Daily: read every configured source into one snapshot. A source that fails is recorded on its own, and the rest still land. */
export async function pullFigures(ctx: Ctx<Settings>) {
  const sets: Record<string, FigureSet> = {};
  const attempt = async (key: string, label: string, read: () => Promise<Figure[]>) => {
    try { sets[key] = { key, label, rows: await read() }; }
    catch (e: any) { sets[key] = { key, label, rows: [], error: String(e?.message ?? "read failed").slice(0, 120) }; ctx.log(`pull-figures: ${key} not read`); }
  };
  if (ctx.settings.xero) for (const x of XERO_SETS) await attempt(x.key, x.label, () => xeroRows(ctx, x.key));
  if (ctx.settings.power_bi) {
    for (const [name, dax] of Object.entries(ctx.settings.power_bi.queries ?? {})) {
      if (!/^[a-z0-9-]{1,60}$/.test(name)) { ctx.log(`pull-figures: skipped a query name that is not a plain word`); continue; }
      await attempt(`dax:${name}`, `Power BI: ${name}`, () => powerBiRows(ctx, ctx.settings.power_bi!.dataset_id, dax));
    }
  }
  if (ctx.settings.microsoft_365?.numbers_pack) await attempt("numbers-pack", "Numbers pack", () => numbersPack(ctx));
  const snap: Snapshot = { at: ctx.now.toISOString(), sets };
  await ctx.store.put("figures", "latest", snap);
  const failed = Object.values(sets).filter((s) => s.error).length;
  ctx.log(`pull-figures: ${Object.keys(sets).length} sets, ${failed} not read`);
  return { sets: Object.keys(sets).length, failed };
}

/** Every 15 minutes: pick up new questions from the owner. Nothing is answered or sent here. */
export async function readQuestions(ctx: Ctx<Settings>) {
  let added = 0;
  for (const q of await readOwnerQuestions(ctx)) {
    if (await ctx.store.get("questions", q.id)) continue;
    await ctx.store.put("questions", q.id, q);
    added++;
  }
  ctx.log(`read-questions: ${added} new`);
  return { added };
}

/** Every 30 minutes: draft each new answer to the owner, then queue its send. Re-runs never draft or queue a question twice. */
export async function answerQuestions(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("figures", "latest");
  if (!snap) { ctx.log("answer-questions: no figures yet"); return { drafted: 0, queued: 0 }; }
  const open = Object.values(await ctx.store.list<Question>("questions")).filter((q) => q.status === "new" || q.status === "drafted");
  let drafted = 0, queued = 0;
  for (const q of open) {
    if (!q.text.trim()) { await ctx.store.put("questions", q.id, { ...q, status: "skipped", reason: "empty question" }); continue; }
    let draftId = q.draft_id;
    if (q.status === "new") {
      const a = answerHtml(q, snap);
      draftId = await draftAnswer(ctx, a.subject, a.html);
      drafted++;
      await ctx.store.put("questions", q.id, { ...q, status: "drafted", draft_id: draftId });
    }
    if (!draftId) continue;
    const approval = await ctx.queue(sendAct(ctx, draftId, q.id, q.subject), `Send the answer to "${q.subject}" to the owner`);
    await ctx.store.put("questions", q.id, { ...q, status: "queued", draft_id: draftId, approval });
    queued++;
  }
  ctx.log(`answer-questions: ${drafted} drafted, ${queued} queued for approval`);
  return { drafted, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "pull-figures": pullFigures,
  "read-questions": readQuestions,
  "answer-questions": answerQuestions,
};
