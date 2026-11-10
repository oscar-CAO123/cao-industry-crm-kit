// The systems monitoring workflow's two crons. The check cron reads and records what is failing; the alert cron drafts one
// email per new failure and queues its send for a person. No cron sends, reconnects, re-runs or fixes anything.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Check, type MonitorPlatform, type Settings, EMAIL, esc, keyOf } from "./types.ts";
import { make } from "./adapters/make.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

const ADAPTERS: Record<MonitorPlatform, typeof make | typeof microsoft365> = { make, "microsoft-365": microsoft365 };

/** Daily: read each checked platform and record each item's status. A platform that cannot be read is itself a failing check,
 *  so a broken connection is reported rather than silently dropped. An item that is no longer listed is recorded as ok. */
export async function check(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  const unreadable: string[] = [];
  let checked = 0, failing = 0;
  for (const p of ctx.settings.checks ?? []) {
    const a = ADAPTERS[p];
    if (!a) throw new Error(`systems-monitoring: no adapter for ${p}`);
    let items: Omit<Check, "seen" | "alerted">[];
    try {
      items = await a.checks(ctx);
    } catch (e: any) {
      ctx.log(`check: ${p} could not be read: ${String(e?.message ?? e).slice(0, 160)}`);
      unreadable.push(p);
      items = [{ key: keyOf(`${p}:platform`), platform: p, kind: "platform", name: p, ok: false, reason: `${p} could not be read this run` }];
    }
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.key);
      const cur = await ctx.store.get<Check>("checks", it.key);
      const since = it.ok ? undefined : cur && !cur.ok && cur.since ? cur.since : now;
      await ctx.store.put("checks", it.key, { ...it, seen: now, since, alerted: !it.ok && !!cur && !cur.ok && cur.alerted === true } satisfies Check);
      checked++;
      if (!it.ok) failing++;
    }
    // Only when the platform answered: an item it no longer lists has cleared. An unreadable platform clears nothing.
    if (!unreadable.includes(p)) {
      for (const [key, c] of Object.entries(await ctx.store.list<Check>("checks"))) {
        if (c.platform !== p || seen.has(key)) continue;
        await ctx.store.put("checks", key, { ...c, ok: true, reason: undefined, since: undefined, alerted: false, seen: now } satisfies Check);
      }
    }
  }
  ctx.log(`check: ${checked} checked, ${failing} failing, ${unreadable.length} unreadable`);
  return { checked, failing, unreadable };
}

/** Every 30 minutes: one alert email per new failure, drafted in the client's mailbox, with its send queued for approval.
 *  A failure is alerted once until it clears, so a re-run never drafts or queues the same thing again. */
export async function alert(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Check>("checks")).filter((c) => !c.ok && !c.alerted).sort((a, b) => a.key.localeCompare(b.key));
  if (!todo.length) return { alerted: 0 };
  const to = ctx.settings.alert_to;
  if (!to || !EMAIL.test(to)) throw new Error("systems-monitoring: alert_to is not a valid address");
  // The start of each failure is in the key: the same failure that clears and comes back is a new alert, not the old approval.
  const fingerprint = todo.map((c) => `${c.key}@${c.since ?? ""}=${c.reason ?? ""}`).join("|");
  const rows = todo.map((c) => `<li><b>${esc(c.name)}</b> (${esc(c.platform)}): ${esc(c.reason ?? "failing")}</li>`).join("");
  const html = `<p>Hi ${esc(ctx.settings.business_name ?? "there")}, ${todo.length} check${todo.length === 1 ? "" : "s"} failed in today's run:</p>`
    + `<ul>${rows}</ul><p>Nothing has been changed. Check each item on its platform.</p>`;
  const d = await microsoft365.alertDraft(ctx, { to, subject: `Systems check: ${todo.length} failing`, html });
  await ctx.queue({ ...d.act, key: keyOf(`alert:${fingerprint}`) }, `Send systems alert to ${to}: ${todo.map((c) => c.name).join(", ")}`);
  for (const c of todo) await ctx.store.put("checks", c.key, { ...c, alerted: true } satisfies Check);
  ctx.log(`alert: ${todo.length} queued`);
  return { alerted: todo.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { check, alert };
