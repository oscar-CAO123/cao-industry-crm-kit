// Make: connection expiry dates, scenarios flagged invalid or with dead-letter runs, and error logs from the last day.
// Read only. Nothing is re-run, reconnected or changed here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Check, type Settings, DAY, NUMID, oneLine } from "../types.ts";

const P = "make";
/** A Make log timestamp is milliseconds or an ISO string. Anything else is not counted. */
const when = (v: unknown) => (typeof v === "number" ? v : Date.parse(String(v ?? "")));

export const make: Adapter = {
  id: P,
  async checks(ctx: Ctx<Settings>): Promise<Omit<Check, "seen" | "alerted">[]> {
    const out: Omit<Check, "seen" | "alerted">[] = [];
    const now = ctx.now.getTime();
    const warnDays = Math.max(1, Number(ctx.settings.make?.expiry_warn_days ?? 14));
    // Make lists connections and scenarios per team; the team id comes from settings, digits only.
    const teamId = String(ctx.settings.make?.team_id ?? "");
    if (!NUMID.test(teamId)) throw new Error("make.team_id must be the Make team id (digits)");

    const conns = await ctx.draft<any>({ platform: P, op: "core.docs.get_connections", summary: "read Make connections", input: { params: { teamId } } });
    for (const c of conns.data?.connections ?? []) {
      const id = String(c.id ?? "");
      if (!NUMID.test(id)) continue;
      const exp = Date.parse(String(c.expire ?? ""));
      const days = Number.isFinite(exp) ? (exp - now) / DAY : undefined;
      let reason: string | undefined;
      if (days !== undefined && days < 0) reason = "the connection's key has expired";
      else if (days !== undefined && days <= warnDays) reason = `the connection's key expires in ${Math.floor(days)} days`;
      out.push({ key: `make:connection:${id}`, platform: P, kind: "connection", name: oneLine(c.accountLabel || c.name || c.accountName || `connection ${id}`, 120), ok: !reason, reason });
    }

    const list = await ctx.draft<any>({ platform: P, op: "core.docs.get_scenarios", summary: "read Make scenarios", input: { params: { teamId } } });
    const only = ctx.settings.make?.scenario_ids?.length ? ctx.settings.make.scenario_ids.map(String) : undefined;
    const scenarios = (list.data?.scenarios ?? [])
      .filter((s: any) => NUMID.test(String(s.id ?? "")) && s.deleted !== true && (!only || only.includes(String(s.id))))
      .slice(0, 20);
    for (const s of scenarios) {
      const id = String(s.id);
      const reasons: string[] = [];
      if (s.isinvalid === true) reasons.push("the scenario is invalid");
      const dlq = Number(s.dlqCount ?? 0);
      if (dlq > 0) reasons.push(`${dlq} runs are in the dead-letter queue`);
      const logs = await ctx.draft<any>({ platform: P, op: "core.docs.get_scenarios_scenarioId_logs", summary: `read recent logs for scenario ${id}`, input: { params: { scenarioId: id } } });
      const errors = (logs.data?.scenarioLogs ?? []).filter((l: any) => l.status === 3 && when(l.timestamp) >= now - DAY).length;
      if (errors > 0) reasons.push(`${errors} error${errors === 1 ? "" : "s"} in the last 24 hours`);
      out.push({ key: `make:scenario:${id}`, platform: P, kind: "scenario", name: oneLine(s.name || `scenario ${id}`, 120), ok: reasons.length === 0, reason: reasons.join("; ") || undefined });
    }
    return out;
  },
};
