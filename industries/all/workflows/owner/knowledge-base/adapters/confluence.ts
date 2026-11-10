// Confluence: where existing pages are read from, and where new knowledge base entries are written. An entry is created
// as a draft page (a draft operation, visible only to its editor) and published only when a person approves the update.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Source, NUMID, keyOf, plain, isStale } from "../types.ts";

const P = "confluence";
const cfg = (ctx: Ctx<Settings>) => {
  const c = ctx.settings.confluence;
  if (!c?.kb_space_id || !NUMID.test(c.kb_space_id)) throw new Error("confluence.kb_space_id is not set");
  return c;
};

export const confluence = {
  id: P,
  /** Current pages in the source space, most recently changed first. Flags pages whose last version is past the limit. */
  async sources(ctx: Ctx<Settings>): Promise<Omit<Source, "status">[]> {
    const sid = ctx.settings.confluence?.source_space_id;
    if (!sid) return [];
    if (!NUMID.test(sid)) throw new Error("confluence.source_space_id is not a space id");
    const days = ctx.settings.stale_after_days ?? 180;
    const r = await ctx.draft<any>({ platform: P, op: "openapi-v2-v3.getPages", summary: "read existing pages", input: { params: {
      "space-id": sid, status: "current", "body-format": "storage", sort: "-modified-date", limit: 25 } } });
    return (r.data?.results ?? []).filter((p: any) => NUMID.test(String(p.id ?? ""))).map((p: any) => {
      const modified = String(p.version?.createdAt ?? p.createdAt ?? "") || undefined;
      return { id: keyOf(`confluence:${p.id}`), platform: P, title: String(p.title ?? "Existing page").slice(0, 200),
        text: plain(String(p.body?.storage?.value ?? "")), modified, stale: isStale(ctx.now, modified, days),
        seen: ctx.now.toISOString(), ref: { page_id: String(p.id) } };
    });
  },
  /** Create the entry as a draft page in the knowledge base space. Nothing is published here. */
  async draftPage(ctx: Ctx<Settings>, title: string, html: string): Promise<{ page: string; version: number }> {
    const r = await ctx.draft<any>({ platform: P, op: "openapi-v2-v3.createPage", summary: `draft knowledge base page "${title}"`, input: { body: {
      spaceId: cfg(ctx).kb_space_id, status: "draft", title, body: { representation: "storage", value: html } } } });
    const page = String(r.data?.id ?? "");
    if (!NUMID.test(page)) throw new Error("confluence: knowledge base draft page not created");
    return { page, version: Number(r.data?.version?.number ?? 1) };
  },
  /** The live act that publishes the draft. The approval runs it; a cron only queues it. An update takes the next version number. */
  publishAct(s: { page: string; version: number; title: string; html: string }): Act {
    return { platform: P, op: "openapi-v2-v3.updatePage", summary: `publish "${s.title}" to the knowledge base`, input: { params: { id: s.page }, body: {
      id: s.page, status: "current", title: s.title, body: { representation: "storage", value: s.html }, version: { number: s.version + 1, message: "Published after review" } } } };
  },
};
