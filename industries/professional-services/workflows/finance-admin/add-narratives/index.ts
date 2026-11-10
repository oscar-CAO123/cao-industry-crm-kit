// The billing narratives workflow's three crons. capture and refresh only read. draft creates one DRAFT invoice in Xero per
// client and queues its authorisation: the approval is the only thing that authorises it.
import { safeKey, type Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Entry, type Proposal, type InvoiceRecord, DAY, guid, round2, money, day, cleanNarrative } from "./types.ts";
import { timeEntries, project, taskRates, draftInvoice, authoriseAct, invoiceStatus, type DraftLine } from "./adapters/xero.ts";

const LOOKBACK_DAYS = 31;
const MAX_LINES = 100;
const projectIds = (s: Settings) => (s.projects ?? []).map((p) => guid(p));

/** Every 30 minutes: read each client's chargeable, uninvoiced time entries. An entry that left ACTIVE is marked gone. */
export async function capture(ctx: Ctx<Settings>) {
  const windowStart = ctx.now.getTime() - (ctx.settings.lookback_days ?? LOOKBACK_DAYS) * DAY;
  const stamp = ctx.now.toISOString();
  let read = 0, added = 0, gone = 0;
  const existing = await ctx.store.list<Entry>("entries");
  for (const pid of projectIds(ctx.settings)) {
    // Read back as far as the oldest entry still waiting, not only the lookback: a waiting entry is marked gone only when
    // Xero stops listing it as ACTIVE, never because it aged out of the window.
    const waiting = Object.values(existing).filter((e) => e.project_id === pid && e.status === "new")
      .map((e) => Date.parse(`${e.date}T00:00:00Z`)).filter(Number.isFinite);
    const since = new Date(Math.min(windowStart, ...waiting) - DAY).toISOString();
    const rows = await timeEntries(ctx, pid, since);
    const seen = new Set(rows.map((r) => r.id));
    read += rows.length;
    for (const r of rows) {
      const old = existing[r.id];
      if (!old) { await ctx.store.put("entries", r.id, { ...r, status: "new", seen: stamp } satisfies Entry); added++; continue; }
      if (old.status === "new") await ctx.store.put("entries", r.id, { ...old, ...r, status: "new", seen: stamp } satisfies Entry); // still waiting: take Xero's current copy
    }
    for (const old of Object.values(existing)) {
      if (old.project_id === pid && old.status === "new" && !seen.has(old.id)) {
        await ctx.store.put("entries", old.id, { ...old, status: "gone", seen: stamp } satisfies Entry);
        gone++;
      }
    }
  }
  ctx.log(`capture: ${read} read, ${added} new, ${gone} gone`);
  return { read, added, gone };
}

/** Twice an hour: for each client with new entries and a narrative proposal, draft one invoice in Xero and queue its authorisation. */
export async function draft(ctx: Ctx<Settings>) {
  const entries = Object.values(await ctx.store.list<Entry>("entries"));
  const clients = [...new Set(entries.filter((e) => e.status === "new").map((e) => e.project_id))];
  let drafted = 0, parked = 0;
  for (const pid of clients) {
    const open = entries.filter((e) => e.project_id === pid && e.status === "new");
    const byId = new Map(open.map((e) => [e.id, e]));
    const park = async (reason: string) => { parked++; await ctx.store.put("parked", pid, { project_id: pid, reason, at: ctx.now.toISOString() }); };

    const prop = await ctx.store.get<Proposal>("proposals", pid);
    if (!prop?.lines?.length || prop.lines.length > MAX_LINES) { await park("no narrative proposal yet: the agent writes one from the time entries"); continue; }
    const covered = new Set<string>();
    let bad = "";
    for (const l of prop.lines) if (!Array.isArray(l.entry_ids)) bad = "a proposal line has no entry_ids list";
    for (const id of prop.lines.flatMap((l) => (Array.isArray(l.entry_ids) ? l.entry_ids : []))) {
      if (!byId.has(id) || covered.has(id)) bad = `entry ${id} is not a new entry of this client, or is listed twice`;
      covered.add(id);
    }
    const missing = open.filter((e) => !covered.has(e.id)).length;
    if (!bad && missing) bad = `${missing} time entries not covered by the proposal`;
    if (bad) { await park(bad); continue; }

    const info = await project(ctx, pid);
    if (!info.contact) { await park("the Xero project has no client contact"); continue; }
    const rates = await taskRates(ctx, pid);

    const lines: DraftLine[] = [];
    let problem = "";
    for (const [i, l] of prop.lines.entries()) {
      const description = cleanNarrative(l.narrative);
      if (!description) { problem = `line ${i + 1} has no usable narrative`; break; }
      const override = typeof l.unit_amount === "number" ? l.unit_amount : undefined;
      if (override !== undefined && !(override >= 0 && override <= 100000)) { problem = `line ${i + 1} has a bad unit amount`; break; }
      const es = l.entry_ids.map((id) => byId.get(id)!);
      const rateSet = new Set(es.map((e) => override ?? rates[e.task_id]));
      if (rateSet.size !== 1 || rateSet.has(undefined)) { problem = `line ${i + 1} mixes rates or has no rate: split it or set unit_amount`; break; }
      const minutes = es.reduce((a, e) => a + e.minutes, 0);
      lines.push({ description, quantity: round2(minutes / 60), unit_amount: [...rateSet][0] as number });
    }
    if (problem) { await park(problem); continue; }

    const ids = open.map((e) => e.id).sort();
    const key = safeKey(`narr:${pid}:${ids.join(",")}`, 120);
    const total = round2(lines.reduce((a, l) => a + l.quantity * l.unit_amount, 0));
    const hours = round2(lines.reduce((a, l) => a + l.quantity, 0));
    const invoiceId = await draftInvoice(ctx, { contact: info.contact, key, reference: `Time narratives ${day(ctx.now)}`, lines });
    const summary = `Authorise draft invoice for ${info.name}: ${lines.length} lines, ${hours} hours, ${money(total)} ex GST`;
    const approval = await ctx.queue(authoriseAct(invoiceId, summary), summary);
    await ctx.store.put("invoices", invoiceId, { id: invoiceId, project_id: pid, entry_ids: ids, total_ex_gst: total, status: "draft", approval, created: ctx.now.toISOString() } satisfies InvoiceRecord);
    for (const e of open) await ctx.store.put("entries", e.id, { ...e, status: "drafted", invoice: invoiceId } satisfies Entry);
    await ctx.store.put("parked", pid, { project_id: pid, reason: undefined, at: ctx.now.toISOString() });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} parked`);
  return { drafted, parked };
}

/** Daily: record which draft invoices were authorised or voided in Xero. A voided draft returns its entries to new. */
export async function refresh(ctx: Ctx<Settings>) {
  let checked = 0, changed = 0;
  for (const inv of Object.values(await ctx.store.list<InvoiceRecord>("invoices"))) {
    if (inv.status !== "draft") continue;
    checked++;
    let st: string | undefined;
    try { st = await invoiceStatus(ctx, inv.id); } catch (e) { ctx.log(`refresh: ${inv.id} not read: ${(e as Error).message}`); continue; }
    if (st === "AUTHORISED" || st === "PAID") { await ctx.store.put("invoices", inv.id, { ...inv, status: "authorised" } satisfies InvoiceRecord); changed++; }
    else if (st === "VOIDED" || st === "DELETED") {
      await ctx.store.put("invoices", inv.id, { ...inv, status: "voided" } satisfies InvoiceRecord);
      for (const id of inv.entry_ids) {
        const e = await ctx.store.get<Entry>("entries", id);
        if (e && e.invoice === inv.id) await ctx.store.put("entries", id, { ...e, status: "new", invoice: undefined } satisfies Entry);
      }
      changed++;
    }
  }
  ctx.log(`refresh: ${checked} draft invoices checked, ${changed} changed`);
  return { checked, changed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { capture, draft, refresh };
