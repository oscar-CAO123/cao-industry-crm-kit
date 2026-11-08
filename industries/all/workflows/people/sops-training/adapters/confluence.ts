// Confluence: where know-how pages are read from, and where SOPs are written. An SOP is created as a draft page
// (a draft operation, visible to nobody but its editor) and published only when a person approves the update.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Source, NUMID, keyOf, plain } from "../types.ts";

const P = "confluence";
const cfg = (ctx: Ctx<Settings>) => {
  const c = ctx.settings.confluence;
  if (!c?.sop_space_id || !NUMID.test(c.sop_space_id)) throw new Error("confluence.sop_space_id is not set");
  return c;
};

export const confluence = {
  id: P,
  /** Current pages in the source space, most recently changed first. Returns no sources when no source space is set. */
  async sources(ctx: Ctx<Settings>): Promise<Omit<Source, "status">[]> {
    const sid = ctx.settings.confluence?.source_space_id;
    if (!sid) return [];
    if (!NUMID.test(sid)) throw new Error("confluence.source_space_id is not a space id");
    const r = await ctx.draft<any>({ platform: P, op: "openapi-v2-v3.getPages", summary: "read know-how pages", input: { params: {
      "space-id": sid, status: "current", "body-format": "storage", sort: "-modified-date", limit: 25 } } });
    return (r.data?.results ?? []).filter((p: any) => NUMID.test(String(p.id ?? ""))).map((p: any) => ({
      id: keyOf(`confluence:${p.id}`), platform: P, kind: "page" as const, title: String(p.title ?? "Know-how page").slice(0, 200),
      text: plain(String(p.body?.storage?.value ?? "")), received: String(p.createdAt ?? ctx.now.toISOString()), ref: { page_id: String(p.id) } }));
  },
  /** Create the SOP as a draft page in the SOP space and return its id and version. Nothing is published here. */
  async draftPage(ctx: Ctx<Settings>, title: string, html: string): Promise<{ page: string; version: number }> {
    const r = await ctx.draft<any>({ platform: P, op: "openapi-v2-v3.createPage", summary: `draft SOP page "${title}"`, input: { body: {
      spaceId: cfg(ctx).sop_space_id, status: "draft", title, body: { representation: "storage", value: html } } } });
    const page = String(r.data?.id ?? "");
    if (!NUMID.test(page)) throw new Error("confluence: SOP draft page not created");
    return { page, version: Number(r.data?.version?.number ?? 1) };
  },
  /** The live act that publishes the draft. The approval runs it; a cron only queues it. */
  publishAct(s: { page: string; version: number; title: string; html: string }): Act {
    return { platform: P, op: "openapi-v2-v3.updatePage", summary: `publish SOP "${s.title}" to the SOP space`, input: { params: { id: s.page }, body: {
      id: s.page, status: "current", title: s.title, body: { representation: "storage", value: s.html }, version: { number: s.version, message: "Published after review" } } } };
  },
};
