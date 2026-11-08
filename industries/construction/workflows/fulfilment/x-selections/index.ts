// The client selections workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (answering a client's question from the booklet, deciding whether a change is an extra) belongs to the agent
// skill in SKILL.md. Every pack and chase email is a Gmail draft, and the send waits in the approval queue.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type SelectionState, DAY, EMAIL, keyOf } from "./types.ts";
import { googleWorkspace as gw, checkSettings, packMail, chaseMail } from "./adapters/google-workspace.ts";

/** Every 30 minutes: read the register (the client's form answers land in it) and keep each row's latest status. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let seen = 0, added = 0;
  for (const row of await gw.register(ctx)) {
    const key = keyOf(row.project, row.client, row.selection);
    const prev = await ctx.store.get<SelectionState>("selections", key);
    if (!prev) added++;
    await ctx.store.put("selections", key, {
      key, row, seen: ctx.now.toISOString(), chases: prev?.chases ?? [],
      pack_draft: prev?.pack_draft, pack_queued: prev?.pack_queued,
    } satisfies SelectionState);
    seen++;
  }
  ctx.log(`intake: ${seen} register rows, ${added} new`);
  return { seen, added };
}

/** Every hour: draft the pack email for each row marked Pack ready, then queue its send for approval. */
export async function draft(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let drafted = 0, queued = 0, parked = 0;
  for (const s of Object.values(await ctx.store.list<SelectionState>("selections"))) {
    if (s.row.status !== "pack-ready" || s.pack_queued) continue;
    if (!EMAIL.test(s.row.email)) {
      s.reason = "no valid client email in the register";
      await ctx.store.put("selections", s.key, s);
      parked++;
      continue;
    }
    if (!s.pack_draft) {
      s.pack_draft = await gw.createDraft(ctx, s.row.email, packMail(ctx.settings, s.row));
      await ctx.store.put("selections", s.key, s);   // remember the draft at once: a rerun never drafts the pack twice
      drafted++;
    }
    const summary = `Send the selection pack to ${s.row.client} (${s.row.email}) for ${s.row.selection} on ${s.row.project}`;
    await gw.queueSend(ctx, s.pack_draft, `pack:${s.key}`, summary);
    s.pack_queued = true;
    s.reason = undefined;
    await ctx.store.put("selections", s.key, s);
    queued++;
  }
  ctx.log(`draft: ${drafted} packs drafted, ${queued} queued, ${parked} parked`);
  return { drafted, queued, parked };
}

/** Daily: for each undecided choice whose pack has actually gone, queue the next chase when it is due. */
export async function followUp(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const after = ctx.settings.selections?.followup_after_days ?? 3;
  const every = ctx.settings.selections?.chase_every_days ?? 3;
  const max = ctx.settings.selections?.max_chases ?? 3;
  let queued = 0;
  for (const s of Object.values(await ctx.store.list<SelectionState>("selections"))) {
    if (s.row.status !== "awaiting-choice" || !s.pack_queued) continue;
    if (s.chases.length >= max || !EMAIL.test(s.row.email)) continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `pack:${s.key}`));
    if (!ap || ap.status !== "done") continue;      // a chase only follows a pack that was actually sent
    const sentAt = Date.parse(ap.started ?? ap.decided ?? "");
    if (!Number.isFinite(sentAt)) continue;
    const last = s.chases.length ? Date.parse(s.chases[s.chases.length - 1]) : sentAt;
    const wait = s.chases.length ? every : after;
    if (ctx.now.getTime() - last < wait * DAY) continue;
    const n = s.chases.length + 1;
    const draftId = await gw.createDraft(ctx, s.row.email, chaseMail(ctx.settings, s.row, n));
    await gw.queueSend(ctx, draftId, `chase:${s.key}:${n}`,
      `Send chase ${n} to ${s.row.client} (${s.row.email}) for ${s.row.selection} on ${s.row.project}`);
    s.chases = [...s.chases, ctx.now.toISOString()];
    await ctx.store.put("selections", s.key, s);
    queued++;
  }
  ctx.log(`follow-up: ${queued} chases queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
