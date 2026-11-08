// The supplier quote comparison workflow's three crons. Each reads, drafts or queues. None sends: every chaser send
// waits in the approval queue for a person. Prices are never parsed or ranked here; the estimator reads them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Comparison, Settings } from "./types.ts";
import { CMP_ID, EMAIL, day } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

const DAY = 864e5;
const open = async (ctx: Ctx<Settings>) => Object.values(await ctx.store.list<Comparison>("comparisons")).filter((c) => CMP_ID.test(c.id) && c.status === "open");
const save = (ctx: Ctx<Settings>, c: Comparison) => ctx.store.put("comparisons", c.id, c);
const validSuppliers = (c: Comparison) => c.suppliers.filter((s) => EMAIL.test(s.email));

/** Every 15 minutes: log each new quote reply to an open comparison in the register. Only suppliers on that comparison count. */
export async function intake(ctx: Ctx<Settings>) {
  const comps = await open(ctx);
  if (!comps.length) return { logged: 0 };
  let logged = 0;
  for (const m of await microsoft365.listReplies(ctx)) {
    const c = comps.find((x) => new RegExp(`(^|[^A-Za-z0-9_-])${x.id}($|[^A-Za-z0-9_-])`, "i").test(m.subject));
    if (!c) continue;
    const s = c.suppliers.find((x) => x.email.toLowerCase() === m.email);
    if (!s || (c.reply_ids ?? []).includes(m.id)) continue;
    await microsoft365.logRow(ctx, [day(ctx.now), c.id, s.name, s.email, "Quote received", m.preview.slice(0, 200)]);
    c.reply_ids = [...(c.reply_ids ?? []), m.id];
    c.replies = [...(c.replies ?? []), { id: m.id, email: s.email.toLowerCase(), supplier: s.name, received: m.received, preview: m.preview }];
    await save(ctx, c);
    logged++;
  }
  ctx.log(`intake: ${logged} quotes logged`);
  return { logged };
}

/** Every hour: when a comparison has quotes no draft covers yet, draft the side-by-side for the buyer. Nothing is sent. */
export async function compare(ctx: Ctx<Settings>) {
  let drafted = 0;
  for (const c of await open(ctx)) {
    const got = c.replies?.length ?? 0;
    if (!got || c.compare_drafts?.[String(got)]) continue;
    c.compare_drafts ??= {};
    c.compare_drafts[String(got)] = await microsoft365.draftComparison(ctx, c);
    await save(ctx, c);
    await microsoft365.logRow(ctx, [day(ctx.now), c.id, "", "", "Comparison drafted", `${got} quotes`]);
    drafted++;
  }
  ctx.log(`compare: ${drafted} comparison drafts`);
  return { drafted };
}

/** Daily: for each open comparison that is due, one chaser draft per supplier who has not quoted, each send queued for approval. */
export async function chase(ctx: Ctx<Settings>) {
  const days = ctx.settings.chase_after_days ?? [3, 7];
  let queued = 0;
  for (const c of await open(ctx)) {
    const n = c.chases ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(c.created) < days[n] * DAY) continue;
    const round = n + 1;
    const replied = new Set((c.replies ?? []).map((r) => r.email));
    c.chase_drafts ??= {};
    for (const s of validSuppliers(c).filter((x) => !replied.has(x.email.toLowerCase()))) {
      const email = s.email.toLowerCase(), k = `${round}:${email}`;
      if (!c.chase_drafts[k]) { c.chase_drafts[k] = await microsoft365.draftChase(ctx, c, s, round); await save(ctx, c); }
      await ctx.queue(microsoft365.sendAct(ctx, c.chase_drafts[k], email, `chase${round}:${c.id}:${email}`, `chaser ${round} for quote comparison ${c.id} to ${email}`));
      queued++;
    }
    c.chases = round;
    await save(ctx, c);
  }
  ctx.log(`chase: ${queued} chasers queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, compare, chase };
