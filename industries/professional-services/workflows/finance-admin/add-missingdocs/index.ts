// The missing documents finder's two crons. Each reads and drafts; neither sends.
// Judgment (whether an item really needs a document, what to say to a client) stays with the practice, as SKILL.md describes.
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { microsoft365 as quotingMail } from "../../../../construction/workflows/sales/quoting/adapters/microsoft-365.ts";
import { openItems } from "./adapters/xero.ts";
import { DAY, clientEmail, esc, keyOf, money, type Chase, type Missing, type Settings } from "./types.ts";

const CLIENT = "client"; // one client per workflow: the chase state is kept under this key

// The quoting workflow's Outlook adapter is typed for its own settings. This workflow only needs its mailbox,
// which that adapter reads from settings.microsoft_365, so the type is narrowed here and nothing is modified.
type Mail = { mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> };
const mail = quotingMail as unknown as Mail;

/** Every 6 hours: read Xero for bank transactions and bills with no document, and keep the list. Reads only. */
export async function scan(ctx: Ctx<Settings>) {
  const items = await openItems(ctx);
  const now = ctx.now.toISOString();
  const seen = new Set<string>();
  for (const m of items) {
    seen.add(m.key);
    await ctx.store.put("missing", m.key, { ...m, seen: now, status: "missing" } satisfies Missing);
  }
  let cleared = 0;
  for (const [k, m] of Object.entries(await ctx.store.list<Missing>("missing"))) {
    if (!seen.has(k) && m.status === "missing") { await ctx.store.put("missing", k, { ...m, status: "cleared" } satisfies Missing); cleared++; }
  }
  ctx.log(`scan: ${items.length} with no document, ${cleared} cleared`);
  return { missing: items.length, cleared };
}

/** Daily: one chase email to the client's own address, listing every item with no document, when a chase is due. The email is an Outlook draft; sending it waits for approval. */
export async function chase(ctx: Ctx<Settings>) {
  const to = clientEmail(ctx.settings);
  const days = ctx.settings.chase_after_days ?? [7, 14];
  const maxStage = 1 + days.length;
  const business = ctx.settings.business_name ?? "us";
  const sorted = Object.values(await ctx.store.list<Missing>("missing")).filter((m) => m.status === "missing")
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) { ctx.log("chase: nothing due"); return { queued: 0 }; }
  const prev = await ctx.store.get<Chase>("chases", CLIENT);
  const stage = prev ? prev.stage + 1 : 1;
  if (stage > maxStage) return { queued: 0 };
  if (prev && ctx.now.getTime() - Date.parse(prev.last) < days[prev.stage - 1] * DAY) { ctx.log("chase: nothing due"); return { queued: 0 }; }
  const key = keyOf(`chase:client:${stage}`);
  if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) return { queued: 0 }; // already queued: no second draft, no second approval
  const total = sorted.reduce((a, m) => a + Math.abs(m.amount), 0);
  const rows = sorted.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.reference ?? m.description ?? (m.kind === "bill" ? "Bill" : "Bank transaction"))}</td><td align="right">${esc(money(Math.abs(m.amount)))}</td></tr>`).join("");
  const html = `<p>Hi there,</p>`
    + `<p>${stage > 1 ? "This is a reminder. " : ""}We still need the documents for the items below to finish your books. Please send them back to us, or reply and tell us if an item has no document.</p>`
    + `<table cellpadding="4"><tr><th align="left">Date</th><th align="left">Item</th><th align="right">Amount</th></tr>${rows}</table>`
    + `<p>Thanks,<br>${esc(business)}</p>`;
  const subject = `${stage > 1 ? "Reminder: " : ""}Documents needed for your bookkeeping`;
  const d = await mail.mailDraft(ctx, { to, subject, html });
  await ctx.queue({ ...d.act, key }, `Chase ${stage} to ${to}: ${sorted.length} item(s) with no document, ${money(total)} in total`);
  await ctx.store.put("chases", CLIENT, { stage, last: ctx.now.toISOString(), key } satisfies Chase);
  ctx.log(`chase: 1 queued for approval`);
  return { queued: 1 };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, chase };
