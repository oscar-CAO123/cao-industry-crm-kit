// The procurement workflow's four crons. Each reads, drafts and queues. None sends: a clarification email and a
// purchase order award are only ever queued, and a person approves them in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { keyOf, money, mentions, type Quote, type Settings } from "./types.ts";
import * as mail from "./adapters/microsoft-365.ts";
import * as xero from "./adapters/xero.ts";

const STATUS_CHECK = "Scope";

async function logCheck(ctx: Ctx<Settings>, q: Quote, check: string, result: string) {
  await mail.appendRow(ctx, ctx.settings.checks, [q.key, q.package, check, result]);
}

/** Every 15 minutes: log each new quote reply from the buying mailbox to the register. Nothing is sent. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const m of await mail.replies(ctx)) {
    const key = keyOf(`m365:${m.id}`);
    if (await ctx.store.get<Quote>("quotes", key)) continue;
    const text = `${m.subject} ${m.preview}`;
    const scope = ctx.settings.scope_items.find((s) => mentions(text, s.package));
    const q: Quote = { key, message_id: m.id, package: scope?.package ?? "unassigned", supplier: m.from, email: m.email,
      subject: m.subject, text: m.preview, received: m.received, status: "received", missing: [] };
    await mail.appendRow(ctx, ctx.settings.register, [key, m.received.slice(0, 10), q.package, q.supplier, q.email ?? "", q.subject, "", "Received"]);
    await ctx.store.put("quotes", key, q);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: check each new quote against the scope list for its package. A gap queues a clarification for approval. */
export async function scopeCheck(ctx: Ctx<Settings>) {
  let clarify = 0, checked = 0;
  for (const q of Object.values(await ctx.store.list<Quote>("quotes"))) {
    if (q.status !== "received") continue;
    const scope = ctx.settings.scope_items.find((s) => s.package === q.package);
    if (!scope) {
      q.status = "unassigned";
      await logCheck(ctx, q, STATUS_CHECK, "No scope package matches this quote");
    } else {
      q.missing = scope.items.filter((item) => !mentions(`${q.subject} ${q.text}`, item));
      if (!q.missing.length) {
        q.status = "checked";
        await logCheck(ctx, q, STATUS_CHECK, "Complete");
      } else if (!q.email) {
        q.status = "checked";
        await logCheck(ctx, q, STATUS_CHECK, `Missing: ${q.missing.join(", ")} (no email address to ask)`);
      } else {
        const d = await mail.draftEmail(ctx, q.email, `Quote clarification: ${q.package}`, [
          `Hi ${q.supplier},`,
          `Thanks for your quote for ${q.package}. Could you confirm whether it includes: ${q.missing.join(", ")}?`,
          "If anything is excluded, please say what, and what it would cost to add it back in.",
          `Thanks, ${ctx.settings.business_name ?? "the team"}`,
        ]);
        await ctx.queue({ ...d.act, key: `clarify:${q.key}` }, `send clarification to ${q.email} for ${q.package}: missing ${q.missing.join(", ")}`);
        q.status = "clarify-queued";
        await logCheck(ctx, q, STATUS_CHECK, `Missing: ${q.missing.join(", ")} (clarification queued)`);
        clarify++;
      }
    }
    await ctx.store.put("quotes", q.key, q);
    checked++;
  }
  ctx.log(`scope-check: ${checked} checked, ${clarify} clarifications queued`);
  return { checked, clarify };
}

/** Hourly: a complete quote with an amount in the register becomes a DRAFT purchase order in Xero; the award is queued. */
export async function orderDraft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Quote>("quotes")).filter((q) => q.status === "checked" && !q.missing.length && !q.po);
  if (!todo.length) return { drafted: 0, parked: 0 };
  const register = await mail.rows(ctx, ctx.settings.register);
  let drafted = 0, parked = 0;
  for (const q of todo) {
    const amount = Number(register.find((r) => String(r[0]) === q.key)?.[6]);
    if (!(amount > 0) || amount > 10_000_000) { parked++; ctx.log(`order-draft: ${q.key} waits for an amount ex GST in the register`); continue; }
    const contact = q.email ? await xero.findContact(ctx, q.email) : undefined;
    if (!contact) { parked++; ctx.log(`order-draft: ${q.key} has no Xero contact for ${q.email ?? "no email"}`); continue; }
    const po = await xero.draftPurchaseOrder(ctx, q, contact, amount);
    const label = po.number ?? q.key;
    await ctx.queue({ ...xero.awardAct(po.id, label), key: `award:${q.key}` }, `award ${q.package} to ${q.supplier}: set Xero PO ${label} for ${money(amount)} ex GST to AUTHORISED`);
    q.po = { id: po.id, number: po.number, contact_id: contact, total: amount };
    q.status = "po-draft";
    await ctx.store.put("quotes", q.key, q);
    drafted++;
  }
  ctx.log(`order-draft: ${drafted} drafted, ${parked} parked`);
  return { drafted, parked };
}

/** Daily: compare each purchase order with the supplier's bills. Writes matches and differences to the checks log only. */
export async function billMatch(ctx: Ctx<Settings>) {
  const withPo = Object.values(await ctx.store.list<Quote>("quotes")).filter((q) => q.po);
  if (!withPo.length) return { checked: 0, logged: 0 };
  const all = await xero.bills(ctx);
  let logged = 0;
  for (const q of withPo) {
    const po = q.po!;
    const theirs = all.filter((b) => b.Contact?.ContactID === po.contact_id);
    const result = !theirs.length ? "No bill yet"
      : theirs.some((b) => Number(b.Total) === po.total) ? "Matches the PO"
      : `Differs: bill ${money(Number(theirs[0].Total))} against PO ${money(po.total)}`;
    if (result !== q.bill_check) {
      await logCheck(ctx, q, "Bill", result);
      q.bill_check = result;
      await ctx.store.put("quotes", q.key, q);
      logged++;
    }
  }
  ctx.log(`bill-match: ${withPo.length} checked, ${logged} logged`);
  return { checked: withPo.length, logged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  intake, "scope-check": scopeCheck, "order-draft": orderDraft, "bill-match": billMatch,
};
