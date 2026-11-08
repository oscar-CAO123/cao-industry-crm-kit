// The staff helpdesk's three crons. Each reads, drafts or records, and queues a reply; none sends.
// The answer itself is judgment: the agent skill in SKILL.md reads the sources the draft cron found and writes the answer
// into the store (answers/<question id>). The draft cron checks that answer exists before it drafts and queues a reply.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Adapter, type Platform, type Question, type Settings, type Source, clean, keywords } from "./types.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";
import { slack } from "./adapters/slack.ts";

export const ADAPTERS: Record<Platform, Adapter> = { "google-workspace": googleWorkspace, slack };
const adapter = (p: Platform): Adapter => {
  const a = ADAPTERS[p];
  if (!a) throw new Error(`staff-helpdesk: no adapter for ${p}`);
  return a;
};

/** Every 10 minutes: new questions from each intake platform. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const q of await adapter(p).questions(ctx)) {
      if (await ctx.store.get("questions", q.id)) continue;
      await ctx.store.put("questions", q.id, { ...q, status: "new" } satisfies Question);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

async function findSources(ctx: Ctx<Settings>, q: Question): Promise<Source[]> {
  const words = keywords(`${q.title} ${q.text}`, 4);
  const out: Source[] = [];
  for (const p of ctx.settings.sources ?? []) out.push(...(await adapter(p).search(ctx, words)).slice(0, ctx.settings.max_sources ?? 5));
  return out.slice(0, 10);
}

/** Every 15 minutes: find SOP sources for each open question; where the agent has written an answer, draft the reply and queue its send. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Question>("questions")).filter((q) => q.status === "new" || q.status === "needs-answer");
  let drafted = 0, parked = 0;
  for (const q of todo) {
    const sources = await findSources(ctx, q);
    const ans = await ctx.store.get<{ text?: string }>("answers", q.id);
    const text = clean(ans?.text, 4000).trim();
    if (!text) {
      const reason = sources.length
        ? "no answer written yet: the agent skill reads the sources below and writes one"
        : "no SOP or policy matched: a person needs to answer";
      await ctx.store.put("questions", q.id, { ...q, status: "needs-answer", sources, reason } satisfies Question);
      parked++;
      continue;
    }
    const { act, draft_id } = await adapter(q.source).reply(ctx, q, text);
    await ctx.queue({ ...act, key: `reply:${q.id}` }, `Reply to ${q.asker.name ?? q.asker.email ?? "staff"}: ${q.title}`);
    await ctx.store.put("questions", q.id, { ...q, status: "drafted", sources, reply: text, draft_id, reason: undefined } satisfies Question);
    drafted++;
  }
  ctx.log(`draft: ${drafted} replies queued, ${parked} need an answer`);
  return { drafted, needs_answer: parked };
}

/** Hourly: one row per question in the register Sheet, once the question has been looked at. Writes a Sheet row only. */
export async function register(ctx: Ctx<Settings>) {
  if (!ctx.settings.google?.log) return { logged: 0 };
  let logged = 0;
  for (const q of Object.values(await ctx.store.list<Question>("questions"))) {
    if (q.logged || q.status === "new") continue;
    await googleWorkspace.logRow(ctx, q);
    await ctx.store.put("questions", q.id, { ...q, logged: ctx.now.toISOString() } satisfies Question);
    logged++;
  }
  ctx.log(`register: ${logged} rows`);
  return { logged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, register };
