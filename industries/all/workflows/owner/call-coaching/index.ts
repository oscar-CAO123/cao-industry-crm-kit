// The call-coaching workflow's two crons. Each is deterministic: it reads, drafts internal records and queues.
// It never sends. Judgment (scoring a transcript against the rubric) belongs to the agent skill in SKILL.md, which
// writes a score per call into the store; the coach cron checks the score before it drafts or queues anything.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { CallRecord, Score, Settings } from "./types.ts";
import { esc, clip } from "./types.ts";
import * as fireflies from "./adapters/fireflies.ts";
import * as gohighlevel from "./adapters/gohighlevel.ts";

const MAX_PER_RUN = 20;
const ADAPTERS = { fireflies, gohighlevel } as const;

/** A score the coach cron will act on: whole numbers in range, one to three plain coaching points. */
export function validScore(s: Score): boolean {
  const parts = Object.values(s?.parts ?? {});
  return Number.isInteger(s?.total) && s.total >= 0 && s.total <= 100
    && parts.length > 0 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 20)
    && Array.isArray(s.coaching) && s.coaching.length >= 1 && s.coaching.length <= 3
    && s.coaching.every((x) => typeof x === "string" && x.length > 0 && x.length <= 300)
    && (s.next_step === undefined || (typeof s.next_step === "string" && s.next_step.length <= 300));
}

const coachingText = (c: CallRecord, s: Score) =>
  `Call coaching for ${c.title} (${c.happened.slice(0, 10)}): ${s.total}/100.\n`
  + s.coaching.map((x) => `- ${x}`).join("\n")
  + (s.next_step ? `\nNext step: ${s.next_step}` : "");

const coachingHtml = (c: CallRecord, s: Score, business?: string) =>
  `<p>Hi, here is your call coaching for ${esc(c.title)}${business ? ` at ${esc(business)}` : ""}. You scored ${esc(s.total)}/100.</p>`
  + `<ul>${s.coaching.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
  + (s.next_step ? `<p>Next step: ${esc(s.next_step)}</p>` : "");

/** The rep's GoHighLevel contact, looked up by the work email Fireflies reports. */
function repContactFor(settings: Settings, rep: string): string | undefined {
  const hit = Object.entries(settings.reps ?? {}).find(([email]) => email.toLowerCase() === rep.toLowerCase());
  return hit?.[1];
}

/** Every 30 minutes: new call transcripts and call logs from each intake source, stored once each. */
export async function capture(ctx: Ctx<Settings>) {
  const max = Math.min(ctx.settings.max_calls_per_run ?? MAX_PER_RUN, 50);
  let added = 0;
  for (const p of ctx.settings.intake) {
    const wm = `capture-${p}`;
    const since = (await ctx.store.get<{ since: string }>("state", wm))?.since;
    const found = p === "fireflies" ? await fireflies.recent(ctx, since, max) : await gohighlevel.recent(ctx, since, max);
    let newest = since;
    for (const c of found) {
      if (await ctx.store.get("calls", c.key)) continue;
      await ctx.store.put("calls", c.key, c);
      added++;
      if (!newest || c.happened > newest) newest = c.happened;
    }
    if (newest) await ctx.store.put("state", wm, { since: newest });
  }
  ctx.log(`capture: ${added} new calls`);
  return { added };
}

/** Hourly: for each scored call, draft the coaching note on its contact and queue the rep email for approval. */
export async function coach(ctx: Ctx<Settings>) {
  const calls = Object.values(await ctx.store.list<CallRecord>("calls"));
  const scores = await ctx.store.list<Score>("scores");
  let noted = 0, queued = 0;
  for (const c of calls) {
    const s = scores[c.key];
    if (!s || c.coached) continue;
    if (!validScore(s)) { ctx.log(`coach: ${c.key} has an invalid score, skipped`); continue; }
    let done = false;
    if (c.platform === "gohighlevel" && (await gohighlevel.note(ctx, c, coachingText(c, s)))) { noted++; done = true; }
    const repContact = c.rep ? repContactFor(ctx.settings, c.rep) : undefined;
    if (repContact) {
      await gohighlevel.queueRepEmail(ctx, c, repContact, `Your call coaching: ${c.title}`, coachingHtml(c, s, ctx.settings.business_name),
        `Coaching email to ${c.rep} about ${c.title}: ${s.total}/100`);
      queued++; done = true;
    } else if (c.platform === "fireflies") ctx.log(`coach: no rep contact for ${clip(c.rep ?? "an unnamed host", 200)}, nothing queued for ${c.key}`);
    if (done) await ctx.store.put("calls", c.key, { ...c, coached: ctx.now.toISOString() });
  }
  ctx.log(`coach: ${noted} notes drafted, ${queued} rep emails queued`);
  return { noted, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { capture, coach };
