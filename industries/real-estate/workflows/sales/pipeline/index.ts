// The real-estate pipeline workflow's two crons. Each reads Agentbox and keeps its own record in the workflow store.
// Nothing here sends, books or changes a contact in Agentbox. The stage and follow-up judgment belongs to SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Prospect, Settings, VendorContact } from "./types.ts";
import { listContacts, getContact, text } from "./adapters/agentbox.ts";

const DAY = 864e5;
const MAX_DETAIL = 25;

const toProspect = (c: VendorContact, firstSeen: string): Prospect => ({
  id: c.id,
  name: [text(c.forename), text(c.surname)].filter(Boolean).join(" ") || c.id,
  email: text(c.email, 190) || undefined,
  mobile: text(c.mobilePhone, 30) || undefined,
  modified: text(c.modified, 40) || undefined,
  first_seen: firstSeen,
  stage: "untracked",
});

/** Hourly: add each contact on the first page that the pipeline has not seen, and refresh the ones that changed. */
export async function pipelineSync(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  const contacts = await listContacts(ctx);
  let added = 0, updated = 0;
  for (const c of contacts) {
    const prior = await ctx.store.get<Prospect>("prospects", c.id);
    if (!prior) {
      await ctx.store.put("prospects", c.id, toProspect(c, now));
      added++;
      continue;
    }
    const fresh = toProspect(c, prior.first_seen);
    if (fresh.modified !== prior.modified) {
      await ctx.store.put("prospects", c.id, { ...prior, name: fresh.name, email: fresh.email, mobile: fresh.mobile, modified: fresh.modified });
      updated++;
    }
  }
  ctx.log(`pipeline-sync: ${contacts.length} seen, ${added} added, ${updated} updated`);
  return { seen: contacts.length, added, updated };
}

/** Each morning: read the detail of untracked prospects not yet read, then list the ones due for follow-up. */
export async function prospectReview(ctx: Ctx<Settings>) {
  const nowMs = ctx.now.getTime();
  const days = Math.max(1, Math.min(365, Number(ctx.settings.stale_after_days ?? 7)));
  const all = Object.values(await ctx.store.list<Prospect>("prospects"));
  let detailed = 0;
  for (const p of all.sort((a, b) => a.first_seen.localeCompare(b.first_seen))) {
    if (detailed >= MAX_DETAIL) break;
    if (p.stage !== "untracked" || p.detail_checked) continue;
    detailed++;
    const c = await getContact(ctx, p.id);
    const fresh = c ? toProspect(c, p.first_seen) : undefined;
    await ctx.store.put("prospects", p.id, {
      ...p,
      ...(fresh ? { name: fresh.name, email: fresh.email, mobile: fresh.mobile, modified: fresh.modified } : {}),
      detail_checked: ctx.now.toISOString(),
    });
  }
  const after = Object.values(await ctx.store.list<Prospect>("prospects"));
  const untracked = after.filter((p) => p.stage === "untracked");
  const due = untracked
    .filter((p) => nowMs - Date.parse(p.stage_changed ?? p.first_seen) > days * DAY)
    .map((p) => p.id)
    .sort();
  await ctx.store.put("reviews", "latest", {
    generated: ctx.now.toISOString(), untracked: untracked.length, stale_after_days: days, due_for_follow_up: due.slice(0, 200),
  });
  ctx.log(`prospect-review: ${detailed} detail read, ${untracked.length} untracked, ${due.length} due`);
  return { detailed, untracked: untracked.length, due: due.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pipelineSync, prospectReview };
