// The after-hours calls workflow's three crons. Each reads, drafts and queues; none texts anyone.
// The phone system answers the call (set up there). These crons read what came in out of hours, flag urgent calls,
// draft a caller record, and queue a text back and an urgent alert. A person approves every text in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Adapter, type CallRecord, type Platform, type Settings, checkSettings, insideHours, PHONE } from "./types.ts";
import { aircall } from "./adapters/aircall.ts";
import { justcall, textAct } from "./adapters/justcall.ts";

export const ADAPTERS: Record<Platform, Adapter> = { aircall, justcall };
const HOUR = 3600e3;
const URGENT_DEFAULT = ["burst", "flood", "gas", "no power", "no hot water", "leak", "smoke", "sparking", "emergency", "urgent"];

/** Every 10 minutes: new calls from each platform's log that came in outside opening hours. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const since = new Date(ctx.now.getTime() - (ctx.settings.lookback_hours ?? 24) * HOUR);
  let added = 0;
  for (const p of new Set(ctx.settings.call_platforms)) {
    for (const c of await ADAPTERS[p].calls(ctx, since)) {
      if (await ctx.store.get("calls", c.id)) continue;                     // seen before: intake never adds it twice
      const after = !insideHours(new Date(c.received), ctx.settings.hours);
      await ctx.store.put("calls", c.id, { ...c, status: after ? "new" : "skipped", urgent: false,
        reason: after ? undefined : "inside opening hours" } satisfies CallRecord);
      if (after) added++;
    }
  }
  ctx.log(`intake: ${added} after-hours calls`);
  return { added };
}

/** Every 15 minutes: flag urgent calls, draft a caller record, and queue the texts for approval. */
export async function triage(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  const todo = Object.values(await ctx.store.list<CallRecord>("calls")).filter((c) => c.status === "new");
  let urgent = 0, texts = 0, contacts = 0;
  for (const c of todo) {
    const words = (c.notes ?? "").toLowerCase();
    c.urgent = (s.urgent_terms ?? URGENT_DEFAULT).some((t) => words.includes(t.toLowerCase()));   // a flag only: nothing runs from the words
    if (c.urgent) urgent++;
    if (c.platform === "aircall" && s.aircall?.create_contacts && c.caller && !c.ref?.contact_id) {
      const contact = await aircall.createContact!(ctx, c);
      if (contact) { c.ref = { ...c.ref, contact_id: contact }; contacts++; }
    }
    if (c.urgent && s.on_call && s.justcall && PHONE.test(s.on_call.phone)) {
      const when = c.received.replace("T", " ").slice(0, 16);
      await ctx.queue(textAct(s, s.on_call.phone, `Urgent after-hours call from ${c.caller ?? "an unknown number"} at ${when} UTC. Check the call log.`, `alert:${c.id}`),
        `Text ${s.on_call.name ?? "the on-call person"}: urgent after-hours call from ${c.caller ?? "an unknown number"}`);
    }
    if (s.confirm_text && s.justcall && c.caller) {
      await ctx.queue(textAct(s, c.caller, `Thanks for calling ${s.business_name}. We have your message and will get back to you when the office opens.`, `confirm:${c.id}`),
        `Text ${c.caller}: confirm their after-hours message was received`);
      texts++;
    }
    c.status = "triaged";
    await ctx.store.put("calls", c.id, c);
  }
  ctx.log(`triage: ${todo.length} triaged, ${urgent} urgent, ${texts} texts queued, ${contacts} caller records drafted`);
  return { triaged: todo.length, urgent, texts_queued: texts, contacts_drafted: contacts };
}

/** Daily, early morning: a plain-text handover of the out-of-hours calls not yet handed over (a weekend is covered). No platform write. */
export async function morningHandover(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const since = ctx.now.getTime() - 72 * HOUR;
  const rows = Object.values(await ctx.store.list<CallRecord>("calls"))
    .filter((c) => c.status === "triaged" && !c.handed_over && Date.parse(c.received) >= since)
    .sort((a, b) => a.received.localeCompare(b.received));
  if (!rows.length) return { calls: 0, urgent: 0 };
  const urgent = rows.filter((c) => c.urgent).length;
  const lines = rows.map((c) => `${c.urgent ? "URGENT  " : ""}${c.received.replace("T", " ").slice(0, 16)} UTC  ${c.caller ?? "number not given"}  (${c.platform} call ${c.call_id})`);
  const text = [`After-hours calls for ${ctx.settings.business_name}: ${rows.length} (${urgent} urgent)`, ...lines].join("\n");
  await ctx.store.put("handovers", `${ctx.now.toISOString().slice(0, 10)}-${ctx.now.getTime()}`, { created: ctx.now.toISOString(), calls: rows.length, urgent, text });
  for (const c of rows) await ctx.store.put("calls", c.id, { ...c, handed_over: ctx.now.toISOString() });
  ctx.log(`morning-handover: ${rows.length} calls, ${urgent} urgent`);
  return { calls: rows.length, urgent };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, triage, "morning-handover": morningHandover };
