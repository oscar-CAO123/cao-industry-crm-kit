// The PR and media workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (writing the release and each pitch, choosing journalists) belongs to the agent skill in SKILL.md.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Pitch, type Settings, EMAIL, DAY, day, keyOf, oneLine } from "./types.ts";
import { draftMail, queueSend, replyTime } from "./adapters/google-workspace.ts";

const FOLLOW_UP = "Hi {name}, following up on my note in case it got buried. Happy to send anything else that helps.";
/** "{name}" in owner-written text becomes the journalist's first name, or "there" when none is known. */
const fill = (text: string, p: { name?: string }) => text.replace(/\{name\}/g, () => oneLine(p.name ?? "", 120).split(" ")[0] || "there").slice(0, 10000);

/** Every hour: one pitch to each approved journalist who has not had one for this release. The send waits for approval. */
export async function pitch(ctx: Ctx<Settings>) {
  const rel = ctx.settings.release;
  if (!rel?.id || !rel.subject || !rel.text) throw new Error("pitch-media: set release.id, release.subject and release.text");
  const cap = Math.min(ctx.settings.max_pitches_per_run ?? 10, 25);
  let drafted = 0, skipped = 0;
  for (const t of ctx.settings.media_list) {
    if (drafted >= cap) break;
    if (!EMAIL.test(t.email)) { skipped++; continue; }
    const key = keyOf(`pitch:${rel.id}:${t.email.toLowerCase()}`);
    if (await ctx.store.get("pitches", key)) continue;
    const d = await draftMail(ctx, { to: t.email, subject: rel.subject, text: fill(rel.text, t) });
    const summary = `Send pitch "${oneLine(rel.subject, 80)}" to ${t.email}${t.outlet ? ` (${oneLine(t.outlet, 80)})` : ""}`;
    await queueSend(ctx, `send:${key}`, d.draftId, summary);
    await ctx.store.put("pitches", key, { key, campaign: rel.id, to: t.email, name: oneLine(t.name ?? "", 120) || undefined,
      outlet: oneLine(t.outlet ?? "", 120) || undefined, subject: rel.subject, status: "draft", draft_id: d.draftId, thread_id: d.threadId,
      created: ctx.now.toISOString(), followups: [] } satisfies Pitch);
    drafted++;
  }
  ctx.log(`pitch: ${drafted} drafted, ${skipped} skipped`);
  return { drafted, skipped };
}

/** Daily: mark approved pitches as sent, stop the chase on any reply, and queue the follow-ups that are due. */
export async function followUp(ctx: Ctx<Settings>) {
  const days = ctx.settings.follow_up?.after_days ?? [3, 7];
  const text = ctx.settings.follow_up?.text ?? FOLLOW_UP;
  const pitches = Object.values(await ctx.store.list<Pitch>("pitches"));
  for (const p of pitches) {
    if (p.status !== "draft") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `send:${p.key}`));
    // Sent once the send itself succeeded, even if the approval has not finished.
    if (ap && (ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300)) {
      p.status = "sent"; p.sent_at = ap.started ?? ap.decided;
      await ctx.store.put("pitches", p.key, p);
    }
  }
  let replies = 0, queued = 0;
  for (const p of pitches) {
    if (p.status !== "sent" || p.replied) continue;
    const at = await replyTime(ctx, p.thread_id);
    if (at) { p.replied = at; replies++; await ctx.store.put("pitches", p.key, p); }
  }
  for (const p of pitches) {
    if (p.status !== "sent" || p.replied || !p.sent_at) continue;
    const n = p.followups.length;
    if (n >= days.length || ctx.now.getTime() - Date.parse(p.sent_at) < days[n] * DAY) continue;
    const d = await draftMail(ctx, { to: p.to, subject: `Re: ${p.subject}`, text: fill(text, p), threadId: p.thread_id });
    await queueSend(ctx, `send:follow${n + 1}:${p.key}`, d.draftId, `Send follow-up ${n + 1} for "${oneLine(p.subject, 80)}" to ${p.to}`);
    p.followups = [...p.followups, ctx.now.toISOString()];
    await ctx.store.put("pitches", p.key, p);
    queued++;
  }
  ctx.log(`follow-up: ${queued} queued, ${replies} replies`);
  return { queued, replies };
}

/** Weekly: one joined report of pitches, replies and follow-ups, drafted to the owner and queued for approval. */
export async function report(ctx: Ctx<Settings>) {
  const rel = ctx.settings.release;
  const key = `report:${rel.id}:${day(ctx.now)}`;
  if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, `send:${key}`))) return { queued: 0 };
  const mine = Object.values(await ctx.store.list<Pitch>("pitches")).filter((p) => p.campaign === rel.id);
  const sent = mine.filter((p) => p.status === "sent");
  const replied = mine.filter((p) => p.replied);
  const followups = mine.reduce((a, p) => a + p.followups.length, 0);
  const lines = [
    `Media pitch report: ${oneLine(rel.subject, 200)}`,
    `Week to ${day(ctx.now)}`,
    "",
    `Pitches drafted: ${mine.length}`,
    `Sent after approval: ${sent.length}`,
    `Replies in the pitch thread: ${replied.length}`,
    `Follow-ups queued: ${followups}`,
    "",
    "Replied:",
    ...(replied.length
      ? replied.map((p) => `- ${oneLine(p.name ?? p.to, 120)}${p.outlet ? `, ${p.outlet}` : ""} (${p.to}), replied ${day(new Date(p.replied!))}`)
      : ["- none yet"]),
    "",
    "Not tracked here: published articles and mentions, and bookings or revenue from coverage.",
  ];
  const d = await draftMail(ctx, { to: ctx.settings.report_to, subject: `Media pitch report: ${rel.subject}`, text: lines.join("\n") });
  await queueSend(ctx, `send:${key}`, d.draftId, `Send media pitch report to ${ctx.settings.report_to}`);
  return { queued: 1 };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pitch, "follow-up": followUp, report };
