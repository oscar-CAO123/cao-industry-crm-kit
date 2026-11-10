// The documents workflow's three crons. Each reads, drafts or queues. Nothing reaches a client without an approval in the CRM shell.
// Judgment (writing a report from figures, a letter that answers a specific question) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Request, type Settings, ID, EMAIL, HEADER, oneLine, requestKey } from "./types.ts";
import { googleWorkspace as G } from "./adapters/google-workspace.ts";

const ROLES = ["reader", "commenter"];

/** A misconfigured client fails loudly on every run, before any call is made. */
function check(s: Settings) {
  const g = s.google;
  if (!g || !ID.test(g.spreadsheet_id) || !ID.test(g.output_folder_id)) throw new Error("documents: google.spreadsheet_id and output_folder_id must be set");
  if (!g.records?.range || !g.records.columns) throw new Error("documents: google.records needs a range and its column names");
  for (const h of Object.values(g.records.columns)) if (!HEADER.test(h)) throw new Error(`documents: column name "${h}" is not a valid header`);
  if (!Array.isArray(s.documents) || !s.documents.length) throw new Error("documents: at least one document template is needed");
  for (const d of s.documents) if (!d.kind || !ID.test(d.template_id)) throw new Error(`documents: template for "${d.kind}" needs a valid template_id`);
  for (const d of s.documents) {
    if (!Array.isArray(d.fields) || !d.fields.length) throw new Error(`documents: template for "${d.kind}" needs a fields list naming the record columns it uses`);
    for (const h of d.fields) if (!HEADER.test(h)) throw new Error(`documents: field "${h}" for "${d.kind}" is not a valid column name`);
  }
  if (s.share_role && !ROLES.includes(s.share_role)) throw new Error("documents: share_role must be reader or commenter");
}

const save = (ctx: Ctx<Settings>, q: Request) => ctx.store.put("requests", requestKey(q.id), q);

/** Every 10 minutes: each record marked ready in the records tab becomes a request, once. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  check(ctx.settings);
  const r = ctx.settings.google.records, c = r.columns, ready = (r.ready_value ?? "ready").toLowerCase();
  let added = 0, skipped = 0;
  for (const row of await G.records(ctx)) {
    if ((row[c.status] ?? "").trim().toLowerCase() !== ready) continue;
    const id = (row[c.id] ?? "").trim();
    if (!ID.test(id)) { skipped++; continue; }
    if (await ctx.store.get("requests", requestKey(id))) continue;
    const kind = oneLine(row[c.kind], 60), email = (row[c.email] ?? "").trim();
    const tpl = ctx.settings.documents.find((d) => d.kind === kind), known = !!tpl;
    const used = new Set(tpl?.fields ?? []);  // only the columns this kind's template fills are kept on the request
    const fields = Object.fromEntries(Object.entries(row).filter(([h]) => used.has(h)).map(([h, v]) => [h, oneLine(v, 500)]));
    await save(ctx, { id, kind, email: EMAIL.test(email) ? email : undefined, fields, received: ctx.now.toISOString(),
      status: known ? "new" : "needs-person", reason: known ? undefined : `no template for kind "${kind}"` });
    added++;
  }
  ctx.log(`intake: ${added} new, ${skipped} with a bad id`);
  return { added, skipped };
}

/** Every 15 minutes: copy the template for each new request, fill it, check for leftover placeholders, log the row. Nothing is shared here. */
export async function draft(ctx: Ctx<Settings>) {
  check(ctx.settings);
  const todo = Object.values(await ctx.store.list<Request>("requests")).filter((q) => q.status === "new" || q.status === "copied");
  let drafted = 0, needs_person = 0;
  for (const q of todo) {
    const tpl = ctx.settings.documents.find((d) => d.kind === q.kind);
    if (!tpl) { q.status = "needs-person"; q.reason = `no template for kind "${q.kind}"`; await save(ctx, q); needs_person++; continue; }
    if (!q.doc_id) {   // stored before filling, so a run that stops here never makes a second copy
      q.doc_id = await G.copyTemplate(ctx, tpl.template_id, oneLine(`${q.kind} ${q.id}`, 120));
      q.status = "copied";
      await save(ctx, q);
    }
    await G.fill(ctx, q.doc_id, q.fields);
    const left = await G.leftover(ctx, q.doc_id);
    q.url = `https://docs.google.com/document/d/${q.doc_id}/edit`;
    if (left.length) { q.status = "needs-person"; q.reason = `placeholders not filled: ${left.slice(0, 5).join(", ")}`; needs_person++; }
    else { q.status = "drafted"; q.reason = undefined; drafted++; }
    await save(ctx, q);
    await G.log(ctx, [ctx.now.toISOString(), q.id, q.kind, q.url, q.status, q.reason ?? ""]);
  }
  ctx.log(`draft: ${drafted} drafted, ${needs_person} need a person`);
  return { drafted, needs_person };
}

/** Every 30 minutes: hold any draft with open comments or no client email; queue the share to the client for approval otherwise. */
export async function queue(ctx: Ctx<Settings>) {
  check(ctx.settings);
  const role = ctx.settings.share_role ?? "reader";
  const todo = Object.values(await ctx.store.list<Request>("requests")).filter((q) => (q.status === "drafted" || q.status === "held") && q.doc_id);
  let queued = 0, held = 0;
  for (const q of todo) {
    const open = await G.openComments(ctx, q.doc_id!);
    if (open) { q.status = "held"; q.reason = `${open} open comment(s) on the draft`; held++; await save(ctx, q); continue; }
    if (!q.email) { q.status = "held"; q.reason = "no valid client email on the record"; held++; await save(ctx, q); continue; }
    q.approval = await G.queueShare(ctx, q.doc_id!, q.email, role, q.id);
    q.status = "queued"; q.reason = undefined;
    await save(ctx, q);
    queued++;
  }
  ctx.log(`queue: ${queued} queued for approval, ${held} held`);
  return { queued, held };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, queue };
