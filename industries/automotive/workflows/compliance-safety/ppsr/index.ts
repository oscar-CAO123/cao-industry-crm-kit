// The PPSR workflow's two crons. Both read and draft only: the digest email is queued for a person to approve.
// Running a PPSR search and lodging a registration are person steps (see SKILL.md); no cron touches the PPSR site.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Check, type Settings, type Stock, TO_SEARCH, DISCHARGE_DUE, day, digestHtml, toCheck, toStock } from "./types.ts";
import { tableRows, appendRows, draftMail, sendAct } from "./adapters/microsoft-365.ts";

/** Every morning: each stock vehicle with no check row yet goes into the register as To search. Re-runs add nothing new. */
export async function register(ctx: Ctx<Settings>) {
  const m = ctx.settings.microsoft_365;
  const stock = (await tableRows(ctx, m.stock)).map(toStock).filter((s): s is Stock => s !== null);
  const have = new Set((await tableRows(ctx, m.checks)).map(toCheck).filter((c): c is Check => c !== null).map((c) => c.vin));
  const fresh: Stock[] = [];
  for (const s of stock) if (!have.has(s.vin)) { have.add(s.vin); fresh.push(s); }
  await appendRows(ctx, m.checks, fresh.map((s) => [day(ctx.now), s.vin, s.rego, s.stock, TO_SEARCH, "", "", "from stock list"]));
  ctx.log(`register: ${fresh.length} added to the check register`);
  return { added: fresh.length };
}

/** Every morning: one digest of searches to run and discharges due, drafted in the mailbox and queued for approval.
 *  No digest on a day with nothing to report, and never a second digest for the same day. */
export async function digest(ctx: Ctx<Settings>) {
  const key = day(ctx.now);
  if (await ctx.store.get("digests", key)) return { queued: 0, reason: "already drafted today" };
  const m = ctx.settings.microsoft_365;
  const checks = (await tableRows(ctx, m.checks)).map(toCheck).filter((c): c is Check => c !== null);
  const toSearch = checks.filter((c) => c.status === TO_SEARCH);
  const due = checks.filter((c) => c.status === DISCHARGE_DUE);
  if (!toSearch.length && !due.length) return { queued: 0, reason: "nothing to report" };
  const subject = `PPSR checks: ${toSearch.length} to search, ${due.length} discharge due`;
  const id = await draftMail(ctx, ctx.settings.compliance_contact, subject, digestHtml(ctx.settings.business_name, toSearch, due));
  const approval = await ctx.queue(sendAct(ctx, id, `Send PPSR digest to ${ctx.settings.compliance_contact}`, `digest:${key}`),
    `${subject}, to ${ctx.settings.compliance_contact}`);
  await ctx.store.put("digests", key, { approval, message: id, created: ctx.now.toISOString() });
  ctx.log(`digest: queued ${approval}`);
  return { queued: 1, to_search: toSearch.length, discharge_due: due.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, digest };
