// The CRM hygiene workflow's two crons. scan reads and drafts a register of fixes in the workflow store; queue turns each
// open item into an approval. Nothing changes in the CRM until a person approves a queued merge or email tidy.
// Judgment (whether two records are really the same person) stays with the person in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Contact, Finding, Platform, Settings } from "./types.ts";
import { ID, byOldest, checkSettings, norm, tidy, valid } from "./types.ts";
import { hubspot } from "./adapters/hubspot.ts";
import { pipedrive } from "./adapters/pipedrive.ts";

export const ADAPTERS: Record<Platform, Adapter> = { hubspot, pipedrive };
const adapter = (s: Settings): Adapter => { checkSettings(s); return ADAPTERS[s.crm]; };
/** Approvals queued in one run, so a long register spreads over several runs. */
const QUEUE_LIMIT = 50;

/** Weekly: read the records, group them by email address and draft the register. Changes nothing in the CRM. */
export async function scan(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now.toISOString();
  const contacts: Contact[] = [];
  let cursor: string | undefined, truncated = false;
  for (;;) {
    const p = await a.page(ctx, cursor);
    contacts.push(...p.items);
    if (!p.next || p.next === cursor || p.items.length === 0) break;
    if (contacts.length >= s.read_limit) { truncated = true; break; }
    cursor = p.next;
  }

  // Group by address. The record kept in each group is the oldest.
  const groups = new Map<string, Contact[]>();
  for (const c of contacts) {
    for (const e of new Set(c.emails.map(norm))) {
      if (!valid(e)) continue;
      const g = groups.get(e) ?? [];
      if (!g.some((x) => x.id === c.id)) g.push(c);
      groups.set(e, g);
    }
  }
  const found = new Map<string, Finding>();
  const merged = new Set<string>();       // records that are a duplicate: merged, not tidied
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [keep, ...rest] = [...list].sort(byOldest);
    for (const c of rest) {
      const key = `dup:${s.crm}:${c.id}:${keep.id}`;
      merged.add(c.id);
      found.set(key, { key, platform: s.crm, kind: "duplicate", id: c.id, with: keep.id,
        summary: `Merge ${c.id} into ${keep.id}: both hold the same email address`, status: "open", first_seen: now, seen_at: now });
    }
  }
  if (s.fix_email_case) for (const c of contacts) {
    if (merged.has(c.id) || !c.emails.some((e) => tidy(e) !== e)) continue;
    const key = `tidy:${s.crm}:${c.id}`;
    found.set(key, { key, platform: s.crm, kind: "email-tidy", id: c.id,
      summary: `Tidy the email address on record ${c.id} (trim and lowercase)`, status: "open", first_seen: now, seen_at: now });
  }

  // Upsert the register. A queued item keeps its approval; a resolved item that comes back is open again.
  const prior = await ctx.store.list<Finding>("findings");
  let added = 0, resolved = 0;
  for (const f of found.values()) {
    const prev = prior[f.key];
    if (prev && prev.status !== "resolved") {
      if (prev.status === "open") await ctx.store.put("findings", f.key, { ...prev, seen_at: now });
      continue;
    }
    await ctx.store.put("findings", f.key, { ...f, first_seen: now }); added++;
  }
  // A finding is resolved only by a full read: a cut-short read cannot show that a record has stopped matching.
  if (!truncated) for (const prev of Object.values(prior)) {
    if (prev.platform !== s.crm || prev.status !== "open" || found.has(prev.key)) continue;
    await ctx.store.put("findings", prev.key, { ...prev, status: "resolved", seen_at: now }); resolved++;
  }
  ctx.log(`scan: ${contacts.length} records read, ${found.size} open items, ${added} new, ${resolved} resolved${truncated ? " (read cut short at read_limit)" : ""}`);
  return { read: contacts.length, open: found.size, added, resolved, truncated };
}

/** Daily at 22:00 UTC (8 or 9 am in eastern Australia): queue each open item for approval. A merge or an email change runs only when a person approves it. */
export async function queue(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now.toISOString();
  const open = Object.values(await ctx.store.list<Finding>("findings"))
    .filter((f) => f.platform === s.crm && f.status === "open" && ID.test(f.id))
    .slice(0, QUEUE_LIMIT);
  let queued = 0, resolved = 0;
  for (const f of open) {
    if (f.kind === "duplicate") {
      const approval = await a.queueMerge(ctx, f, `merge:${f.key}`);
      await ctx.store.put("findings", f.key, { ...f, status: "queued", approval, seen_at: now }); queued++;
      continue;
    }
    if (!s.fix_email_case) continue;
    const approval = await a.queueTidy(ctx, f, `tidy:${f.key}`);
    if (!approval) { await ctx.store.put("findings", f.key, { ...f, status: "resolved", seen_at: now }); resolved++; continue; }
    await ctx.store.put("findings", f.key, { ...f, status: "queued", approval, seen_at: now }); queued++;
  }
  ctx.log(`queue: ${queued} changes queued for approval, ${resolved} already tidy`);
  return { queued, resolved };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, queue };
