// Klaviyo: the flows that already exist, and a live or manual change to one for approval. Creating campaigns is not
// mapped here (see gaps in workflow.json), so Klaviyo is read and flow-status only.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, line, type Settings } from "../types.ts";

const P = "klaviyo";
export const OP = { flows: "get_flows", updateFlow: "update_flow" } as const;
const rev = (s: Settings) => { const r = s.klaviyo?.revision; if (!r) throw new Error("klaviyo: settings.klaviyo.revision is missing"); return r; };

/** Flows in the account, with their status (draft, manual or live). */
export async function flows(ctx: Ctx<Settings>) {
  const r = await ctx.draft<any>({ platform: P, op: OP.flows, summary: "flows", input: { params: { revision: rev(ctx.settings) } } });
  return (r.data?.data ?? []).map((f: any) => ({ id: String(f.id ?? ""), name: line(f.attributes?.name), status: line(f.attributes?.status, 20) }))
    .filter((f: any) => ID.test(f.id));
}

/** Queue a flow's status change for approval. */
export function queueFlowStatus(ctx: Ctx<Settings>, key: string, c: { action: "live" | "manual"; flow_id: string; reason: string }) {
  const summary = `Set Klaviyo flow ${c.flow_id} to ${c.action}: ${line(c.reason, 120)}`;
  return ctx.queue({ platform: P, op: OP.updateFlow, input: {
    params: { id: c.flow_id, revision: rev(ctx.settings) },
    body: { data: { type: "flow", id: c.flow_id, attributes: { status: c.action } } },
  }, summary, key: `flow:${key}` }, summary);
}
