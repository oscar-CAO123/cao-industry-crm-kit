// The condition-report workflow's two crons. Both only read from AgentBox and keep a small local list.
// Writing the report, photos, sign-off and sending stay with the person (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { agentbox } from "./adapters/agentbox.ts";
import { rex } from "./adapters/rex.ts";

const platform = (ctx: Ctx<Settings>) => {
  const p = ctx.settings.platform ?? "agentbox";
  if (p !== "agentbox" && p !== "rex") throw new Error("condition: platform must be agentbox or rex");
  return p === "rex" ? rex : agentbox;
};

/** Every 30 minutes: read the property list so a report starts from the right property. Reads only. */
export async function properties(ctx: Ctx<Settings>) {
  const list: { id: string; address?: string }[] = await platform(ctx).properties(ctx);
  for (const p of list) await ctx.store.put("properties", p.id, { id: p.id, ...(p.address ? { address: p.address } : {}), seen: ctx.now.toISOString() });
  ctx.log(`properties: ${list.length} read`);
  return { read: list.length };
}

/** Hourly, at 15 past: read the contact list so a report goes to the right owner or tenant. Reads only. */
export async function contacts(ctx: Ctx<Settings>) {
  const list: { id: string; name?: string; forename?: string; surname?: string }[] = await platform(ctx).contacts(ctx);
  for (const c of list) {
    const name = c.name ?? `${c.forename ?? ""} ${c.surname ?? ""}`.trim();
    await ctx.store.put("contacts", c.id, { id: c.id, name, seen: ctx.now.toISOString() });
  }
  ctx.log(`contacts: ${list.length} read`);
  return { read: list.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { properties, contacts };
