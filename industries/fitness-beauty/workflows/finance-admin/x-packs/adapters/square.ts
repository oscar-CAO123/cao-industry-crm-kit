// Square: the gift cards a studio or salon still owes. Read only: the cron lists cards in one state and their balances.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { GiftCardRow, Settings } from "../types.ts";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_PAGES = 20;

export async function listGiftCards(ctx: Ctx<Settings>): Promise<{ rows: GiftCardRow[]; skipped: number; truncated: boolean }> {
  const rows: GiftCardRow[] = [];
  let skipped = 0, cursor: string | undefined, page = 0;
  do {
    const params: Record<string, unknown> = { state: ctx.settings.gift_card_state ?? "ACTIVE", limit: 100 };
    if (cursor) params.cursor = cursor;
    const r = await ctx.draft<any>({ platform: "square", op: "api.ListGiftCards", summary: "list gift cards", input: { params } });
    for (const g of r.data?.gift_cards ?? []) {
      const id = String(g?.id ?? ""), cents = Number(g?.balance_money?.amount);
      if (!ID.test(id) || !Number.isInteger(cents) || cents < 0) { skipped++; continue; }
      rows.push({ id, state: String(g.state ?? ""), cents, currency: String(g.balance_money?.currency ?? "AUD") });
    }
    cursor = typeof r.data?.cursor === "string" && r.data.cursor ? r.data.cursor : undefined;
  } while (cursor && ++page < MAX_PAGES);
  return { rows, skipped, truncated: !!cursor };
}
