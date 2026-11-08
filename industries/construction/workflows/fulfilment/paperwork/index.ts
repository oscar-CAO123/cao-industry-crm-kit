// The paperwork workflow's three crons. Each reads, drafts or queues. Nothing reaches a client without an approval in the CRM shell.
// Judgment (the wording of a claim, figures checked against a subcontract or job record) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Request, type Settings, ID, EMAIL, HEADER, oneLine, requestKey } from "./types.ts";
import { googleWorkspace as G } from "./adapters/google-workspace.ts";

/** A misconfigured client fails loudly on every run, before any call is made. */
function check(s: Settings) {
  const g = s.google;
  if (!g || !ID.test(g.spreadsheet_id) || !ID.test(g.output_folder_id)) throw new Error("paperwork: google.spreadsheet_id and output_folder_id must be set");
  if (!g.records?.range || !g.records.columns) throw new Error("paperwork: google.records needs a range and its column names");
  for (const h of Object.values(g.records.columns)) if (!HEADER.test(h)) throw new Error(`paperwork: column name "${h}" is not a valid header`);
  if (!g.log_range) throw new Error("paperwork: google.log_range is not set");
  if (!Array.isArray(s.documents) || !s.documents.length) throw new Error("paperwork: at least one document template is needed");
  for (const d of s.documents) if (!d.kind || !ID.test(d.template_id)) throw new Error(`paperwork: template for "${d.kind}" needs a valid template_id`);
}

const save = (ctx: Ctx<Settings>, r: Request) => ctx.store.put("requests", requestKey(r.id), r);
const park = async (ctx: Ctx<Settings>, r: Request, status: "needs-person" | "held", reason: string) => {
  r.status = status; r.reason = reason; await save(ctx, r);
};

/** Every 10 minutes: each record marked ready in the requests tab becomes a request, once. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  check(ctx.settings);
  const r = ctx.settings.google.records, c = r.columns, ready = (r.ready_value ?? "ready").toLowerCase();
  const skip = new Set(Object.values(c));
  let added = 0, skipped = 0;
  for (const row of await G.records(ctx)) {
    if ((row[c.status] ?? "").trim().toLowerCase() !== ready) continue;
    const id = (row[c.id] ?? "").trim();
    if (!ID.test(id)) { skipped++; continue; }
    if (await ctx.store.get("requests", requestKey(id))) continue;
    const fields = Object.fromEntries(Object.entries(row).filter(([h]) => HEADER.test(h) && !skip.has(h)).map(([h, v]) => [h, oneLine(v, 2000)]));
    const email = (row[c.email] ?? "").trim();
    await save(ctx, { id, kind: oneLine(row[c.kind], 60), email: email || undefined, fields, received: ctx.now.toISOString(), status: "new" });
    added++;
  }
  ctx.log(`intake: ${added} new, ${skipped} skipped`);
  return { added, skipped };
}

/** Every 15 minutes: copy and fill the template for each new request, check it, draft the email, log the row. Never sends. */
export async function draft(ctx: Ctx<Settings>) {
  check(ctx.settings);
  // Held and needs-person requests are retried each run: their copy is reused, so a retry never makes a second one.
  const todo = Object.values(await ctx.store.list<Request>("requests"))
    .filter((r) => r.status === "new" || r.status === "copied" || r.status === "held" || r.status === "needs-person");
  let drafted = 0, parked = 0, held = 0;
  for (const r of todo) {
    const tpl = ctx.settings.documents.find((d) => d.kind.toLowerCase() === r.kind.toLowerCase());
    if (!tpl) { await park(ctx, r, "needs-person", "no template for this kind of document"); parked++; continue; }
    if (!r.email || !EMAIL.test(r.email)) { await park(ctx, r, "needs-person", "no valid client email, so no email draft"); parked++; continue; }
    if (!r.doc_id) {
      r.doc_id = await G.copyTemplate(ctx, tpl.template_id, oneLine(`${r.kind} ${r.id}`, 120));
      r.status = "copied"; await save(ctx, r);   // saved before filling, so a re-run never makes a second copy
    }
    await G.fill(ctx, r.doc_id, r.fields);
    const { text, leftover } = await G.read(ctx, r.doc_id);
    if (leftover.length) { await park(ctx, r, "needs-person", `unfilled fields: ${leftover.slice(0, 5).join(", ")}`); parked++; continue; }
    if (await G.openComments(ctx, r.doc_id)) { await park(ctx, r, "held", "open comments on the draft"); held++; continue; }
    const subject = `${tpl.kind}${ctx.settings.business_name ? ` from ${ctx.settings.business_name}` : ""}`;
    r.draft_id = await G.emailDraft(ctx, r.email, subject, text);
    r.status = "drafted"; r.reason = undefined; await save(ctx, r);   // saved before logging, so a failed log never makes a second draft
    await G.log(ctx, [ctx.now.toISOString().slice(0, 10), r.id, tpl.kind, r.email, "drafted", r.doc_id]);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} need a person, ${held} held`);
  return { drafted, needs_person: parked, held };
}

/** Every 30 minutes: queue the send of each drafted email whose record a person has marked approved in the sheet. Never sends. */
export async function queue(ctx: Ctx<Settings>) {
  check(ctx.settings);
  const r = ctx.settings.google.records, c = r.columns, ok = (r.approved_value ?? "approved").toLowerCase();
  const sheet = new Map((await G.records(ctx)).map((row) => [(row[c.id] ?? "").trim(), (row[c.status] ?? "").trim().toLowerCase()]));
  let queued = 0;
  for (const q of Object.values(await ctx.store.list<Request>("requests"))) {
    if (q.status !== "drafted" || !q.draft_id || sheet.get(q.id) !== ok) continue;
    const summary = `Send "${oneLine(q.kind, 60)}" to ${q.email} (record ${q.id})`;
    q.approval = await G.queueSend(ctx, q.draft_id, q.id, summary);
    q.status = "queued"; await save(ctx, q); queued++;
  }
  ctx.log(`queue: ${queued} queued for approval`);
  return { queued };
}

export const CRONS = { intake, draft, queue };
