// The add-mask workflow's three crons. Each one reads Dropbox and records what it saw, or queues a share for a person to approve.
// None changes a file's contents, and none sends anything: a share waits in the approval queue.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { dropbox } from "./adapters/dropbox.ts";
import { fileId, keyOf, safeEmail, safePath, type MaskedFile, type RawFile, type Settings } from "./types.ts";

/** The approved recipients, checked. A malformed address stops the run before any call is made. */
const recipients = (s: Settings) => s.recipients.map((r) => safeEmail(r.email, "a recipient"));
const owner = (s: Settings) => (s.owner_email ? [safeEmail(s.owner_email, "the owner")] : []);

/** Every 15 minutes: record each new file in the raw folder. Nothing is moved or changed. */
export async function intake(ctx: Ctx<Settings>) {
  const path = safePath(ctx.settings.raw_folder, "the raw folder");
  const { files, has_more } = await dropbox.listFolder(ctx, path);
  let added = 0;
  for (const f of files) {
    const id = fileId(f.id);
    if (!id) { ctx.log("intake: skipped an entry with an unexpected id"); continue; }
    const key = keyOf(id);
    if (await ctx.store.get("raw", key)) continue;
    await ctx.store.put("raw", key, { key, id, path: f.path_display ?? "", name: f.name, seen: ctx.now.toISOString(), status: "new" } satisfies RawFile);
    added++;
  }
  if (has_more) ctx.log("intake: the raw folder has more than one page; the rest is not read (see gaps)");
  ctx.log(`intake: ${added} new`);
  return { added, has_more };
}

/** The masked copies, each with who can see it, recorded in the store. Reads only. */
async function readMasked(ctx: Ctx<Settings>, allowed: Set<string>) {
  const path = safePath(ctx.settings.masked_folder, "the masked folder");
  const { files, has_more } = await dropbox.listFolder(ctx, path);
  const out: MaskedFile[] = [];
  for (const f of files) {
    const id = fileId(f.id);
    if (!id) { ctx.log("masked: skipped an entry with an unexpected id"); continue; }
    const members = await dropbox.emailsWithAccess(ctx, id);
    const key = keyOf(id);
    const rec: MaskedFile = { key, id, path: f.path_display ?? "", name: f.name, seen: ctx.now.toISOString(),
      members, unexpected: members.filter((m) => !allowed.has(m)) };
    await ctx.store.put("masked", key, rec);
    out.push(rec);
  }
  if (has_more) ctx.log("masked: the masked folder has more than one page; the rest is not read (see gaps)");
  return { files: out, has_more };
}

/** Every 30 minutes: for each masked copy, queue a view share to each approved recipient who cannot see it yet. A person approves each one. */
export async function share(ctx: Ctx<Settings>) {
  const want = recipients(ctx.settings);
  const { files } = await readMasked(ctx, new Set([...want, ...owner(ctx.settings)]));
  let queued = 0;
  for (const f of files) {
    for (const email of want) {
      if (f.members.includes(email)) continue;
      await ctx.queue(dropbox.share(f.id, email, `share:${f.key}:${email}`), `Give ${email} view access to ${f.name}`);
      queued++;
    }
  }
  ctx.log(`share: ${queued} queued or already waiting`);
  return { queued };
}

/** Daily: record who can see each masked copy and flag anyone who is neither an approved recipient nor the owner. Changes nothing. */
export async function check(ctx: Ctx<Settings>) {
  const { files } = await readMasked(ctx, new Set([...recipients(ctx.settings), ...owner(ctx.settings)]));
  const flagged = files.filter((f) => f.unexpected.length > 0).length;
  ctx.log(`check: ${files.length} masked copies, ${flagged} with unexpected access`);
  return { checked: files.length, flagged };
}

export const CRONS = { intake, share, check };
