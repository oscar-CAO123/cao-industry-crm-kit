// The knowledge base workflow's two crons. Each one reads, drafts or queues; none publishes or shares on its own.
// Judgment (reading a source and writing its outline into the proposals namespace) belongs to the agent skill in SKILL.md.
// The draft cron turns an outline into a draft page and queues its publish for approval.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { type Entry, type Proposal, type Settings, type Source, checkProposal, entryHtml, entryTitle } from "./types.ts";
import { confluence } from "./adapters/confluence.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";

const SOURCES = { confluence: confluence.sources, "google-workspace": googleWorkspace.sources } as const;

/** Hourly: existing pages and docs, each stored once as a source. Known sources are refreshed (text, date, stale flag);
 *  their status is kept. Nothing is written to any platform. */
export async function gather(ctx: Ctx<Settings>) {
  let added = 0, refreshed = 0;
  for (const p of ctx.settings.know_how ?? []) {
    const read = SOURCES[p];
    if (!read) throw new Error(`knowledge-base: no source reader for ${p}`);
    for (const s of await read(ctx)) {
      const cur = await ctx.store.get<Source>("sources", s.id);
      if (!cur) { await ctx.store.put("sources", s.id, { ...s, status: "new" } satisfies Source); added++; continue; }
      await ctx.store.put("sources", s.id, { ...cur, title: s.title, text: s.text, modified: s.modified, stale: s.stale, seen: s.seen, ref: s.ref } satisfies Source);
      refreshed++;
    }
  }
  const stale = Object.values(await ctx.store.list<Source>("sources")).filter((s) => s.stale).length;
  ctx.log(`gather: ${added} new, ${refreshed} refreshed, ${stale} stale`);
  return { added, refreshed, stale };
}

/** Every 30 minutes: a source with an outline becomes a draft page, and its publish is queued for approval. A source
 *  without a usable outline is parked as needs-writing. A source whose publish was approved is marked published. */
export async function draft(ctx: Ctx<Settings>) {
  let published = 0;
  for (const s of Object.values(await ctx.store.list<Source>("sources"))) {
    if (s.status !== "drafted" || !s.entry) continue;
    const ap = await ctx.store.get<Approval>("approvals", s.entry.approval);
    if (ap?.status === "done") { await ctx.store.put("sources", s.id, { ...s, status: "published" } satisfies Source); published++; }
  }
  const todo = Object.values(await ctx.store.list<Source>("sources")).filter((s) => s.status === "new" || s.status === "needs-writing");
  let drafted = 0, needs_writing = 0;
  for (const s of todo) {
    const got = await ctx.store.get<Proposal>("proposals", s.id);
    const prop = got ? checkProposal(got) : "no outline yet: the agent writes one from the source";
    if (typeof prop === "string") {
      needs_writing++;
      await ctx.store.put("sources", s.id, { ...s, status: "needs-writing", reason: prop } satisfies Source);
      continue;
    }
    const title = entryTitle(prop.title), html = entryHtml(prop);
    const page = await confluence.draftPage(ctx, title, html);
    const approval = await ctx.queue({ ...confluence.publishAct({ ...page, title, html }), key: `publish:${s.id}` });
    const entry: Entry = { title, purpose: prop.purpose, steps: prop.steps, page: page.page, version: page.version, approval };
    await ctx.store.put("sources", s.id, { ...s, status: "drafted", reason: undefined, entry } satisfies Source);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${needs_writing} need an outline, ${published} published`);
  return { drafted, needs_writing, published };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { gather, draft };
