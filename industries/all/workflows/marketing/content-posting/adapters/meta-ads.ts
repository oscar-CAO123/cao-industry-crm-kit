// Meta (Instagram and the Facebook Page): the one adapter this job maps in the kit.
// Instagram publishes in two steps: a container (an unpublished draft, public to nobody) and media_publish (live, so it
// is only ever queued). Facebook posts are live, so they are only ever queued. Field names come from the raw Meta spec in
// the endpoint map: IGUser (image_url, caption, creation_id) and the Page (message, url, caption).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { Channel, PlannedPost, Settings } from "../types.ts";

const P = "meta-ads";
const NUM = /^\d{1,25}$/;
const ok = (r: { status: number }, what: string) => { if (r.status >= 300) throw new Error(`meta-ads: ${what} failed with status ${r.status}`); };
const idOf = (v: unknown, what: string) => { const s = String(v ?? ""); if (!NUM.test(s)) throw new Error(`meta-ads: ${what} is not set`); return s; };

export const meta = {
  /** Draft: an unpublished Instagram container for one picture and caption. Nothing is public until media_publish runs. */
  async instagramContainer(ctx: Ctx<Settings>, p: PlannedPost): Promise<string> {
    const ig = idOf(ctx.settings.meta?.instagram_user_id, "instagram_user_id");
    const r = await ctx.draft<any>({ platform: P, op: "IGUser.post.media", summary: `Instagram container for ${p.id}`,
      input: { params: { "IGUser-id": ig, image_url: p.image_url, caption: p.caption.trim() } } });
    ok(r, "Instagram container");
    const id = String(r.data?.id ?? "");
    if (!NUM.test(id)) throw new Error("meta-ads: no container id came back");
    return id;
  },

  /** The live acts that publish a drafted post to the given channels, in order. These are only ever passed to ctx.queue. */
  liveActs(s: Settings, p: PlannedPost, targets: Channel[]): Act[] {
    const acts: Act[] = [];
    const caption = p.caption.trim();
    if (targets.includes("instagram")) {
      if (!p.instagram?.creation_id) throw new Error(`meta-ads: ${p.id} has no Instagram container yet`);
      acts.push({ platform: P, op: "IGUser.post.media_publish", summary: `publish Instagram post ${p.id}`,
        input: { params: { "IGUser-id": idOf(s.meta?.instagram_user_id, "instagram_user_id"), creation_id: idOf(p.instagram.creation_id, "container id") } } });
    }
    if (targets.includes("facebook")) {
      const page = idOf(s.meta?.facebook_page_id, "facebook_page_id");
      acts.push(p.image_url
        ? { platform: P, op: "Page.post.photos", summary: `publish Facebook photo post ${p.id}`, input: { params: { "Page-id": page, url: p.image_url, caption } } }
        : { platform: P, op: "Page.post.feed", summary: `publish Facebook text post ${p.id}`, input: { params: { "Page-id": page, message: caption } } });
    }
    return acts;
  },

  /** Read: the ids of recent posts on each configured channel. Reads only. */
  async recent(ctx: Ctx<Settings>, channels: Channel[], limit: number): Promise<{ instagram: string[]; facebook: string[] }> {
    const out = { instagram: [] as string[], facebook: [] as string[] };
    if (channels.includes("instagram")) {
      const r = await ctx.draft<any>({ platform: P, op: "IGUser.get.media", summary: "recent Instagram posts",
        input: { params: { "IGUser-id": idOf(ctx.settings.meta?.instagram_user_id, "instagram_user_id") } } });
      ok(r, "Instagram media list");
      out.instagram = (r.data?.data ?? []).slice(0, limit).map((x: any) => String(x?.id ?? "")).filter((x: string) => NUM.test(x));
    }
    if (channels.includes("facebook")) {
      const r = await ctx.draft<any>({ platform: P, op: "Page.get.published_posts", summary: "recent Facebook Page posts",
        input: { params: { "Page-id": idOf(ctx.settings.meta?.facebook_page_id, "facebook_page_id"), limit } } });
      ok(r, "Facebook Page posts");
      out.facebook = (r.data?.data ?? []).slice(0, limit).map((x: any) => String(x?.id ?? "")).filter((x: string) => /^[A-Za-z0-9_]{1,80}$/.test(x));
    }
    return out;
  },
};
