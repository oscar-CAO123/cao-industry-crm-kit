// The policy-answers workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (checking the wording against the policy document, insurer rulings, escalation) belongs to the agent skill
// in SKILL.md. A reply reaches the customer only after a person approves the queued update.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Article, Answer, Enquiry, Settings } from "./types.ts";
import { DAY, ticketId, keyOf } from "./types.ts";
import { zendesk } from "./adapters/zendesk.ts";

export const ADAPTERS: Record<string, Adapter> = { zendesk };
const adapter = (p: string): Adapter => {
  const a = ADAPTERS[p];
  if (!a) throw new Error(`policy: ${p} has no adapter`);
  return a;
};

// Words too common to say what a question is about.
const STOP = new Set(["that", "this", "with", "from", "have", "what", "when", "does", "your", "about", "policy", "will",
  "there", "they", "their", "would", "could", "which", "being", "want", "need", "know", "please", "thanks"]);
const words = (s: string) => [...new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((w) => !STOP.has(w));
const plain = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** The help centre article that best matches the question. A title hit counts double. Nothing matches below a score of 3. */
export function bestArticle(e: Pick<Enquiry, "title" | "text">, articles: Article[]): Article | undefined {
  const q = words(`${e.title} ${e.text ?? ""}`);
  let top: Article | undefined, score = 0;
  for (const a of articles) {
    const t = new Set(words(a.title)), b = new Set(words(a.body));
    const s = q.reduce((n, w) => n + (t.has(w) ? 2 : b.has(w) ? 1 : 0), 0);
    if (s > score) { score = s; top = a; }
  }
  return score >= 3 ? top : undefined;
}

export function answerText(a: Article): string {
  const excerpt = plain(a.body).slice(0, 700);
  return ["Hello,", "", `Thanks for your question. Our help centre covers this in "${a.title}":`, "", excerpt, "",
    `Full article: ${a.html_url}`, "",
    "If that does not fit your situation, reply here and we will go through your policy details with you."].join("\n").slice(0, 1500);
}

/** Every 10 minutes: new open tickets from each intake source. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const e of await adapter(p).enquiries(ctx)) {
      if (await ctx.store.get("enquiries", e.id)) continue;
      await ctx.store.put("enquiries", e.id, { ...e, status: "new" } satisfies Enquiry);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: match each new question to a help centre article and queue the reply for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new" || e.status === "needs-answer");
  if (!todo.length) return { drafted: 0, needs_answer: 0 };
  const articles = await adapter(ctx.settings.intake[0]).articles(ctx);
  let drafted = 0, pending = 0;
  for (const e of todo) {
    const hit = bestArticle(e, articles);
    if (!hit) {
      pending++;
      await ctx.store.put("enquiries", e.id, { ...e, status: "needs-answer", reason: "no help centre article matches: a person answers it" } satisfies Enquiry);
      continue;
    }
    const tid = ticketId(e.ref.ticket_id);
    const body = answerText(hit);
    const summary = `reply to ticket ${tid} from article "${hit.title}" (check the wording against the policy before it goes out)`;
    await ctx.queue({ platform: e.source, op: "core.UpdateTicket", key: `reply:${tid}`, summary,
      input: { params: { ticket_id: tid }, body: { ticket: { comment: { body, public: true } } } } }, summary);
    await ctx.store.put("answers", keyOf(String(tid)), { key: String(tid), enquiry: e.id, article_id: hit.id, body, status: "draft", followups: [] } satisfies Answer);
    await ctx.store.put("enquiries", e.id, { ...e, status: "drafted", reason: undefined } satisfies Enquiry);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${pending} need an answer`);
  return { drafted, needs_answer: pending };
}

/** Daily: mark replies that were approved and sent, close tickets that are solved, queue chasers that are due. */
export async function followUp(ctx: Ctx<Settings>) {
  const answers = Object.values(await ctx.store.list<Answer>("answers"));
  const days = ctx.settings.follow_up?.after_days ?? [3, 7];
  for (const a of answers) {
    if (a.status !== "draft") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `reply:${a.key}`));
    if (ap?.status === "done") { a.status = "sent"; a.sent_at = ap.decided ?? ap.started; }
  }
  const src = ctx.settings.intake[0];
  let queued = 0;
  for (const a of answers.filter((x) => x.status === "sent" && x.sent_at)) {
    const st = await adapter(src).status(ctx, a.key);
    if (st === "solved" || st === "closed") { a.status = "closed"; continue; }
    const n = a.followups.length;
    if (n >= days.length || ctx.now.getTime() - Date.parse(a.sent_at!) < days[n] * DAY) continue;
    const tid = ticketId(a.key);
    const body = "Hello, following up on our reply above. Is there anything else you need on this? If the answer did not cover it, reply here and we will go through it with you.";
    const summary = `chaser ${n + 1} on ticket ${tid} (unanswered since the reply)`;
    await ctx.queue({ platform: src, op: "core.UpdateTicket", key: `chase:${tid}:${n + 1}`, summary,
      input: { params: { ticket_id: tid }, body: { ticket: { comment: { body, public: true } } } } }, summary);
    a.followups = [...a.followups, ctx.now.toISOString()];
    queued++;
  }
  for (const a of answers) await ctx.store.put("answers", keyOf(a.key), a);
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
