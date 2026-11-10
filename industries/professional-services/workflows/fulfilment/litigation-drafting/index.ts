// The litigation drafting workflow's three crons. Each reads, drafts internally, or queues. No cron sends anything.
// Judgment (the pleading matrix, the defence, the case law) belongs to the agent skill in SKILL.md, which writes a
// Draft into the store; the draft cron files it as an internal memo and queues any message to a client for approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { smokeball } from "./adapters/smokeball.ts";
import type { Settings, Matter, Draft } from "./types.ts";

export const ADAPTERS = { smokeball };

/** Every 30 minutes: new lead matters from the case-management system. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const m of await smokeball.leadMatters(ctx)) {
    if (await ctx.store.get("matters", m.id)) continue;
    await ctx.store.put("matters", m.id, { ...m, stage: "new" } satisfies Matter);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Hourly: list each matter's documents; when the count has changed, file an internal inventory memo and a review task. */
export async function fileReview(ctx: Ctx<Settings>) {
  let inventories = 0;
  for (const m of Object.values(await ctx.store.list<Matter>("matters"))) {
    const files = await smokeball.files(ctx, m.id);
    if (!files.length || files.length === m.files_seen) continue;
    const list = files.map((f, i) => `${i + 1}. ${f.name}${f.modified ? ` (modified ${f.modified.slice(0, 10)})` : ""}`).join("\n");
    await smokeball.memo(ctx, m.id, `Document inventory: ${files.length} files`, `Documents on file as of ${ctx.now.toISOString().slice(0, 10)}:\n${list}`);
    await smokeball.task(ctx, m.id, `Review ${files.length} documents on ${m.title}`,
      "Build the chronology and the evidence gaps from the file, then the pleading matrix.");
    await ctx.store.put("matters", m.id, { ...m, stage: "reviewing", files_seen: files.length } satisfies Matter);
    inventories++;
  }
  ctx.log(`file-review: ${inventories} inventories`);
  return { inventories };
}

/** Every two hours: file each pending draft as an internal memo, then queue its client message for approval (never sent here). */
export async function draft(ctx: Ctx<Settings>) {
  let memos = 0, queued = 0;
  const open = Object.values(await ctx.store.list<Draft>("drafts")).filter((d) => d.status === "pending" || d.status === "memo-written");
  for (const d of open) {
    const m = await ctx.store.get<Matter>("matters", d.matter);
    if (!m) { ctx.log(`draft ${d.key}: matter ${d.matter} is not in the store`); continue; }
    let cur: Draft = d;
    if (cur.status === "pending") {
      await smokeball.memo(ctx, cur.matter, cur.title, cur.text);
      memos++;
      cur = { ...cur, status: cur.client_message ? "memo-written" : "done" };
      await ctx.store.put("drafts", cur.key, cur);
    }
    if (cur.status === "memo-written" && cur.client_message) {
      // Read the matter's clients as Smokeball holds them now: the copy stored at intake can be out of date.
      const contact = (await smokeball.clients(ctx, cur.matter))[0];
      if (!contact) { await ctx.store.put("drafts", cur.key, { ...cur, status: "no-contact" }); continue; }
      await ctx.queue(smokeball.clientMessage(cur.matter, contact.id, cur.client_message,
        `portal message to ${contact.name ?? contact.id} on ${m.title}: ${cur.title}`, cur.key));
      queued++;
      await ctx.store.put("drafts", cur.key, { ...cur, status: "done" });
    }
  }
  ctx.log(`draft: ${memos} memos, ${queued} client messages queued for approval`);
  return { memos, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "file-review": fileReview, draft };
