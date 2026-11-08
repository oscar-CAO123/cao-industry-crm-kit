// Square: digital gift cards, gift card activity and loyalty membership.
// Field names come from Square's official spec in the endpoint map (raw/square/spec, api.json):
//   ListGiftCardActivities  query location_id, begin_time, sort_order, limit, cursor; reply gift_card_activities[], cursor
//   CreateGiftCard          body idempotency_key, location_id, gift_card{type, gan_source}; reply gift_card{id}
//   CreateGiftCardActivity  body idempotency_key, gift_card_activity{type, location_id, gift_card_id, activate_activity_details{amount_money, order_id}}
//   ListLoyaltyPrograms     reply programs[]{id}
//   RetrieveLoyaltyAccount  path account_id; reply loyalty_account{balance}
//   CreateLoyaltyAccount    body idempotency_key, loyalty_account{program_id, customer_id, mapping{phone_number}}; reply loyalty_account{id}
// Reads are GETs. Every write is built here and queued by a cron; it runs only when a person approves it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { LedgerRow, Request, Settings } from "../types.ts";
import { ID, PHONE, dollars, idem, money } from "../types.ts";

const P = "square" as const;
const PAGE = 100;

/** The amount on an activity: whichever *_activity_details block carries an amount_money. */
function amountOf(a: any): number | undefined {
  for (const [k, v] of Object.entries(a ?? {})) {
    if (!k.endsWith("_activity_details") || !v || typeof v !== "object") continue;
    const m = (v as any).amount_money;
    if (m && Number.isInteger(m.amount)) return m.amount;
  }
  return undefined;
}

/** Gift card activity from `since` in ascending order, one page at a time, up to maxPages. Reads only. */
export async function activities(ctx: Ctx<Settings>, since: string, maxPages: number): Promise<{ rows: LedgerRow[]; last?: string }> {
  const rows: LedgerRow[] = [];
  let cursor: string | undefined, last: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "api.ListGiftCardActivities", summary: `read gift card activity page ${page + 1}`,
      input: { params: { location_id: ctx.settings.location_id, begin_time: since, sort_order: "ASC", limit: PAGE, ...(cursor ? { cursor } : {}) } } });
    const list: any[] = Array.isArray(r.data?.gift_card_activities) ? r.data.gift_card_activities : [];
    for (const a of list) {
      const id = String(a?.id ?? "");
      if (!ID.test(id)) continue;
      const at = String(a.created_at ?? "");
      const card = String(a.gift_card_id ?? "");
      rows.push({
        key: id,
        type: String(a.type ?? "UNKNOWN").slice(0, 40),
        gift_card_id: ID.test(card) ? card : undefined,
        amount_cents: amountOf(a),
        at,
        location_id: String(a.location_id ?? ""),
      });
      if (!Number.isNaN(Date.parse(at)) && (!last || Date.parse(at) > Date.parse(last))) last = at;
    }
    cursor = typeof r.data?.cursor === "string" && r.data.cursor ? r.data.cursor : undefined;
    if (!cursor || list.length === 0) break;
  }
  return { rows, last };
}

/** The ids of the loyalty programs this business has. Reads only. */
export async function programIds(ctx: Ctx<Settings>): Promise<string[]> {
  const r = await ctx.draft<any>({ platform: P, op: "api.ListLoyaltyPrograms", summary: "read loyalty programs", input: {} });
  const list: any[] = Array.isArray(r.data?.programs) ? r.data.programs : [];
  return list.map((p) => String(p?.id ?? "")).filter((id) => ID.test(id));
}

/** The point balance of one loyalty account. Reads only. */
export async function memberBalance(ctx: Ctx<Settings>, accountId: string): Promise<number | undefined> {
  if (!ID.test(accountId)) throw new Error("gift-cards-loyalty: loyalty account id must be a plain Square id");
  const r = await ctx.draft<any>({ platform: P, op: "api.RetrieveLoyaltyAccount", summary: `read loyalty account ${accountId}`,
    input: { params: { account_id: accountId } } });
  const b = r.data?.loyalty_account?.balance;
  return Number.isInteger(b) ? b : undefined;
}

/** Queued: create a digital gift card (PENDING until it is activated). */
export function issueCardAct(s: Settings, r: Request): Act {
  return { platform: P, op: "api.CreateGiftCard", key: `issue:${r.key}`, summary: `create a digital gift card (request ${r.key})`,
    input: { body: { idempotency_key: idem("gc", r.key), location_id: s.location_id, gift_card: { type: "DIGITAL", gan_source: "SQUARE" } } } };
}

/** Queued: activate a card with its face value, tied to the paid order that funds it. */
export function activateAct(s: Settings, r: Request): Act {
  if (!r.gift_card_id || !ID.test(r.gift_card_id) || !r.order_id || !ID.test(r.order_id)) throw new Error("gift-cards-loyalty: activation needs a card id and an order id");
  if (typeof r.amount_cents !== "number") throw new Error("gift-cards-loyalty: activation needs an amount");
  return { platform: P, op: "api.CreateGiftCardActivity", key: `activate:${r.key}`,
    summary: `activate gift card ${r.gift_card_id} for ${dollars(r.amount_cents)} on order ${r.order_id}`,
    input: { body: { idempotency_key: idem("act", r.key), gift_card_activity: {
      type: "ACTIVATE", location_id: s.location_id, gift_card_id: r.gift_card_id,
      activate_activity_details: { amount_money: money(r.amount_cents), order_id: r.order_id },
    } } } };
}

/** Queued: enrol a member in the loyalty program, by phone number or by Square customer. */
export function enrolAct(s: Settings, r: Request): Act {
  if (!s.loyalty_program_id || !ID.test(s.loyalty_program_id)) throw new Error("gift-cards-loyalty: enrolment needs loyalty_program_id");
  const who = r.phone && PHONE.test(r.phone) ? `ending ${r.phone.slice(-4)}` : `customer ${r.customer_id}`;
  return { platform: P, op: "api.CreateLoyaltyAccount", key: `enrol:${r.key}`, summary: `enrol member ${who} in the loyalty program`,
    input: { body: { idempotency_key: idem("ena", r.key), loyalty_account: {
      program_id: s.loyalty_program_id,
      ...(r.customer_id && ID.test(r.customer_id) ? { customer_id: r.customer_id } : {}),
      ...(r.phone && PHONE.test(r.phone) ? { mapping: { phone_number: r.phone } } : {}),
    } } } };
}
