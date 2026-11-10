// The document-intake workflow's three crons. Each reads, files inside the business's own Dropbox, or queues a
// client-facing file request for approval. None of them sends anything.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { dropbox } from "./adapters/dropbox.ts";
import { type Settings, type Doc, type Rule, safePath, cleanName, keyOf, day, DAY } from "./types.ts";

/** The first rule whose match word appears in the file name (case-insensitive). */
export function ruleFor(s: Settings, name: string): Rule | undefined {
  const n = name.toLowerCase();
  return (s.rules ?? []).find((r) => r.match && n.includes(String(r.match).toLowerCase()));
}

/** Every 15 minutes: record each new file in the intake folder. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  const folder = safePath(ctx.settings.intake_folder, "intake_folder");
  const { entries, has_more } = await dropbox.listFolder(ctx, folder);
  if (has_more) ctx.log("intake: the folder has more than one page; only the first page was read");
  let added = 0;
  for (const e of entries) {
    if (e[".tag"] !== "file" || !e.id || !e.name) continue;
    const key = keyOf(e.id);
    if (await ctx.store.get("documents", key)) continue;
    await ctx.store.put("documents", key, { key, id: e.id, path: e.path_display ?? "", name: e.name,
      received: e.server_modified ?? ctx.now.toISOString(), status: "new" } satisfies Doc);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added, has_more };
}

/** Every 30 minutes: rename each new file to a standard name and file it by its rule. Unmatched files go to review. */
export async function file(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const review = safePath(s.review_folder, "review_folder");
  for (const r of s.rules ?? []) safePath(r.folder, `rule folder for ${r.match}`); // a bad rule stops the run before any move
  const todo = Object.values(await ctx.store.list<Doc>("documents")).filter((d) => d.status === "new");
  const made = new Set<string>();
  let filed = 0, toReview = 0, failed = 0;
  for (const d of todo) {
    const rule = ruleFor(s, d.name);
    const folder = rule ? safePath(rule.folder, "rule folder") : review;
    const received = new Date(d.received);
    const stamp = Number.isNaN(received.getTime()) ? day(ctx.now) : day(received);
    const newName = rule ? `${stamp}_${cleanName(rule.label)}_${cleanName(d.name)}` : cleanName(d.name);
    try {
      if (!made.has(folder)) { await dropbox.ensureFolder(ctx, folder); made.add(folder); }
      const landed = await dropbox.move(ctx, d.id, `${folder}/${newName}`);
      await ctx.store.put("documents", d.key, { ...d, status: rule ? "filed" : "review", label: rule?.label,
        from: d.path, to: landed, filed_at: ctx.now.toISOString() } satisfies Doc);
      if (rule) filed++; else toReview++;
    } catch (e) {
      failed++;
      await ctx.store.put("documents", d.key, { ...d, status: "failed", error: String((e as Error).message).slice(0, 200) } satisfies Doc);
    }
  }
  ctx.log(`file: ${filed} filed, ${toReview} to review, ${failed} failed`);
  return { filed, to_review: toReview, failed };
}

/** Daily: for each checklist item with nothing recent, queue a file request for approval. */
export async function chase(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const dest = safePath(s.request_folder, "request_folder");
  // A checklist folder that is missing or unsafe stops the run before anything is queued.
  const checks = (s.checklist ?? []).map((c) => ({ ...c, folder: safePath(c.folder, `checklist folder for ${c.code}`) }));
  const docs = Object.values(await ctx.store.list<Doc>("documents"));
  const month = ctx.now.toISOString().slice(0, 7);
  let queued = 0;
  for (const c of checks) {
    const cutoff = ctx.now.getTime() - c.within_days * DAY;
    // Only a document a rule has filed into this checklist's folder counts. A file the client named, sitting in review, does not.
    const have = docs.some((d) => d.status === "filed" && (d.to ?? "").toLowerCase().startsWith(`${c.folder}/`.toLowerCase())
      && d.name.toLowerCase().includes(c.match.toLowerCase()) && Date.parse(d.received) >= cutoff);
    if (have) continue;
    await ctx.queue(dropbox.fileRequest(`Please send: ${c.label}`, dest,
      `file request for ${c.label}: no file named "${c.match}" in the last ${c.within_days} days`, `chase:${c.code}:${month}`));
    queued++;
  }
  ctx.log(`chase: ${queued} file requests queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, file, chase };
