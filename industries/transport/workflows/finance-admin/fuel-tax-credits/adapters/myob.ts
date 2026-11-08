// MYOB AccountRight: the fuel tax credit account in the chart of accounts. Read only.
// Field names are from the MYOB Business API v2 Account page (Name, DisplayID, UID, CurrentBalance).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type FuelAccount, type Settings, GUID, money } from "../types.ts";

/** Finds the fuel tax credit account by name. Returns undefined when the chart has no such account. */
export async function fuelAccount(ctx: Ctx<Settings>): Promise<FuelAccount | undefined> {
  const want = (ctx.settings.fuel_account_name ?? "Fuel tax credit").trim().toLowerCase();
  const r = await ctx.draft<any>({ platform: "myob", op: "docs.get_cf_uri_GeneralLedger_Account", summary: "chart of accounts" });
  const rows: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.Items) ? r.data.Items : [];
  const hit = rows.find((a) => String(a.Name ?? "").trim().toLowerCase() === want);
  if (!hit || !GUID.test(String(hit.UID ?? ""))) return undefined;
  return { uid: String(hit.UID), number: hit.DisplayID ? String(hit.DisplayID).slice(0, 13) : undefined,
    balance: money(Number(hit.CurrentBalance ?? 0)), at: ctx.now.toISOString() };
}
