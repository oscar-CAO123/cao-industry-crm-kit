// Klaviyo: the flows an account runs, their 30 day results, the actions inside a flow (reads), and the live switch
// for a flow (an approval act only, never run by a cron). Field names come from Klaviyo's official spec, revision 2026-10-15.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, ID } from "../types.ts";

const REV = "2026-10-15";
const P = "klaviyo";
const id = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("klaviyo: bad id"); return s; };
const metric = (ctx: Ctx<Settings>) => {
  const m = String(ctx.settings.klaviyo?.conversion_metric_id ?? "");
  if (!ID.test(m)) throw new Error("klaviyo.conversion_metric_id is not set");
  return m;
};

export const klaviyo = {
  /** Every flow in the account, read page by page (a read). */
  async flows(ctx: Ctx<Settings>): Promise<{ id: string; name: string; status: string }[]> {
    const out: { id: string; name: string; status: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await ctx.draft<any>({ platform: P, op: "get_flows", summary: "read flows", input: { params: {
        revision: REV, "fields[flow]": ["name", "status", "trigger_type"], "page[size]": 50, ...(cursor ? { "page[cursor]": cursor } : {}) } } });
      for (const x of r.data?.data ?? []) {
        if (ID.test(String(x?.id ?? ""))) out.push({ id: x.id, name: String(x.attributes?.name ?? x.id).slice(0, 120), status: String(x.attributes?.status ?? "unknown").slice(0, 20) });
      }
      const next = r.data?.links?.next;
      cursor = next ? new URL(String(next)).searchParams.get("page[cursor]") ?? undefined : undefined;
      if (!cursor) break;
    }
    return out;
  },
  /** Results per flow over the timeframe, grouped by flow. The spec marks this POST as a write, so the deploy needs KIT_ALLOW_WRITES=1; it changes nothing. */
  async results(ctx: Ctx<Settings>): Promise<Map<string, Record<string, number>>> {
    const k = ctx.settings.klaviyo;
    const r = await ctx.draft<any>({ platform: P, op: "query_flow_values", summary: "read flow results", input: { params: { revision: REV }, body: { data: {
      type: "flow-values-report", attributes: {
        statistics: ["recipients", "conversions", "conversion_rate", "conversion_value"],
        timeframe: { key: k.timeframe ?? "last_30_days" }, conversion_metric_id: metric(ctx), group_by: ["flow_id"] } } } } });
    const out = new Map<string, Record<string, number>>();
    for (const row of r.data?.data?.attributes?.results ?? []) {
      const fid = row?.groupings?.flow_id;
      if (ID.test(String(fid ?? ""))) out.set(fid, row.statistics ?? {});
    }
    return out;
  },
  /** The action ids inside one flow (a read). */
  async actions(ctx: Ctx<Settings>, flowId: string): Promise<string[]> {
    const r = await ctx.draft<any>({ platform: P, op: "get_actions_for_flow", summary: `read actions of flow ${flowId}`, input: { params: {
      id: id(flowId), revision: REV, "page[size]": 50 } } });
    return (r.data?.data ?? []).map((x: any) => String(x?.id ?? "")).filter((x: string) => ID.test(x));
  },
  /** The live switch for a flow. Only ever queued for approval. */
  goLiveAct(flowId: string, name: string) {
    const fid = id(flowId);
    return { platform: P, op: "update_flow", key: `live:${fid}`, summary: `put flow "${name}" live`, input: {
      params: { id: fid, revision: REV }, body: { data: { type: "flow", id: fid, attributes: { status: "live" } } } } };
  },
};
