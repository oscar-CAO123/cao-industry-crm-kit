// Facebook Pages (Meta Graph): the one kit operation that reads a competitor's posts. Read only: a draft. The mapped
// Page.get.posts operation has no fields parameter, so Graph returns its default post fields and message or permalink can be
// absent. Another Page's public posts need a token with Page Public Content Access, which is not checked against a live account.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Post, Settings } from "../types.ts";
import { POST_ID, clean } from "../types.ts";

const ok = (r: { status: number }, what: string) => { if (r.status >= 300) throw new Error(`meta-ads: ${what} failed with status ${r.status}`); };
const FB_LINK = /^https:\/\/(www\.|m\.)?facebook\.com\//;

export const meta = {
  /** Draft: the newest public posts on one competitor's Facebook Page. Reads only; no reply is written anywhere. */
  async pagePosts(ctx: Ctx<Settings>, pageId: string): Promise<Post[]> {
    const r = await ctx.draft<any>({ platform: "meta-ads", op: "Page.get.posts", summary: `posts on Page ${pageId}`,
      input: { params: { "Page-id": pageId, limit: 10 } } });
    ok(r, "page posts");
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    return data
      .filter((x) => POST_ID.test(String(x?.id ?? "")))
      .map((x) => ({
        id: String(x.id),
        created_time: clean(x.created_time, 40),
        message: clean(x.message, 500),
        ...(FB_LINK.test(String(x.permalink_url ?? "")) ? { permalink_url: String(x.permalink_url).slice(0, 300) } : {}),
      }));
  },
};
