// The wholesale workflow's three crons. Each reads and drafts; none sends. Every authorise, email or chase is only ever queued.
// Judgment (reading a purchase order, deciding a stockist is worth opening, pricing a new line) belongs to the agent
// skill in SKILL.md, which writes accounts and orders into the store. The crons check them before anything reaches Xero.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Account, type Order, type Settings, EMAIL, DAY, money, total, lineProblem } from "./types.ts";
import { contactId, draftInvoice, dueFor, sendActs, chaseAct, openInvoices, parseXeroDate } from "./adapters/xero.ts";

const sendId = (ctx: Ctx<Settings>, orderId: string) => approvalId(ctx.workflow.id, `send:${orderId}`);

/** Every 30 minutes: a new stockist account gets its Xero contact, found by email or created as a contact record. */
export async function accountSetup(ctx: Ctx<Settings>) {
  const accounts = Object.values(await ctx.store.list<Account>("accounts")).filter((a) => a.status === "new");
  let set = 0, held = 0;
  for (const a of accounts) {
    if (!a.name?.trim()) { await ctx.store.put("accounts", a.id, { ...a, status: "held", reason: "no account name" }); held++; continue; }
    const id = await contactId(ctx, a);
    const fresh = (await ctx.store.get<Account>("accounts", a.id)) ?? a;
    await ctx.store.put("accounts", a.id, { ...fresh, status: "contact-ready", xero_contact_id: id, reason: undefined });
    set++;
  }
  ctx.log(`account-setup: ${set} set up, ${held} held`);
  return { set, held };
}

/** Every 15 minutes: a ready order becomes a DRAFT invoice in Xero, then its authorise-and-email is queued for approval.
 *  An order already drafted but not yet queued is queued here, so a crash between the two steps never strands it. */
export async function invoice(ctx: Ctx<Settings>) {
  const orders = await ctx.store.list<Order>("orders");
  const accounts = await ctx.store.list<Account>("accounts");
  let drafted = 0, queued = 0, held = 0, sent = 0, rejected = 0;

  for (const o of Object.values(orders).filter((x) => x.status === "ready")) {
    const a = accounts[o.account];
    if (!a || a.status !== "contact-ready" || !a.xero_contact_id) { ctx.log(`invoice: ${o.id} waits for its account's Xero contact`); continue; }
    const bad = !a.email || !EMAIL.test(a.email) ? "account has no valid email for the invoice" : lineProblem(o.lines);
    if (bad) { await ctx.store.put("orders", o.id, { ...o, status: "held", reason: bad }); held++; continue; }
    const due = dueFor(ctx);
    const invoiceId = await draftInvoice(ctx, o, a.xero_contact_id, due);
    await ctx.store.put("orders", o.id, { ...o, status: "invoice-draft", invoice_id: invoiceId, due, reason: undefined });
    drafted++;
  }

  for (const o of Object.values(await ctx.store.list<Order>("orders")).filter((x) => x.status === "invoice-draft")) {
    const a = accounts[o.account];
    const ap = await ctx.store.get<Approval>("approvals", sendId(ctx, o.id));
    if (ap?.status === "done") { await ctx.store.put("orders", o.id, { ...o, status: "invoiced" }); sent++; continue; }
    if (ap?.status === "rejected") { await ctx.store.put("orders", o.id, { ...o, status: "held", reason: "invoice send rejected: check the Xero draft" }); rejected++; continue; }
    if (!a?.xero_contact_id || !a.email) continue;
    // The queue text is logged by the runtime, so it names the account and never carries its email address (the act keeps it).
    await ctx.queue(sendActs(ctx, o, a, a.xero_contact_id), `Authorise and email invoice ${o.id} to ${a.name}: ${o.lines.length} lines, ${money(total(o.lines))} ex GST`);
    if (!ap) queued++;
  }

  ctx.log(`invoice: ${drafted} drafted, ${queued} queued, ${held} held, ${sent} sent, ${rejected} rejected`);
  return { drafted, queued, held, sent, rejected };
}

/** Daily: an overdue invoice gets its next chase queued for approval, once per step (default 7, 14 and 30 days late). */
export async function chase(ctx: Ctx<Settings>) {
  const steps = ctx.settings.chase?.after_days_overdue ?? [7, 14, 30];
  const open = new Map((await openInvoices(ctx)).map((i) => [String(i.InvoiceID), i]));
  const accounts = await ctx.store.list<Account>("accounts");
  let queued = 0;
  for (const o of Object.values(await ctx.store.list<Order>("orders")).filter((x) => x.status === "invoiced" && x.invoice_id)) {
    const inv = open.get(o.invoice_id!);
    const due = parseXeroDate(inv?.DueDate);
    if (!inv || due === undefined) continue; // paid, voided or not open in Xero
    const late = Math.floor((ctx.now.getTime() - due) / DAY);
    const reached = steps.filter((d) => late >= d).length;
    const done = Math.max(0, ...(o.chases ?? []));
    if (reached <= done) continue;
    const a = accounts[o.account];
    if (!a?.email || !EMAIL.test(a.email)) continue;
    await ctx.queue(chaseAct(o, reached), `Chase invoice ${o.id} to ${a.name}: ${money(Number(inv.AmountDue) || 0)} due, ${late} days late`);
    await ctx.store.put("orders", o.id, { ...o, chases: [...(o.chases ?? []), reached] });
    queued++;
  }
  ctx.log(`chase: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "account-setup": accountSetup, invoice, chase };
