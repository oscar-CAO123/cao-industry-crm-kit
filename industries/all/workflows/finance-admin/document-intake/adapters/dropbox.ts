// Dropbox: where the business's documents already live. The crons list the intake folder, make folders, move and rename
// files inside the business's own Dropbox (draft operations), and create file requests (a live operation, queued for approval).
// Field names come from the Dropbox API spec mapped in core/sdk/platforms/dropbox/ops.json.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { ApiError } from "../../../../../../core/lib/http.ts";
import type { Settings } from "../types.ts";

const P = "dropbox";

export interface Entry { ".tag": string; id: string; name: string; path_display?: string; server_modified?: string }

export const dropbox = {
  id: P,

  /** The first page of a folder's entries (files.list_folder/continue is not mapped, so a longer folder is flagged). */
  async listFolder(ctx: Ctx<Settings>, path: string): Promise<{ entries: Entry[]; has_more: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "files.list_folder", summary: `list ${path}`, input: { params: { path } } });
    return { entries: (r.data?.entries ?? []) as Entry[], has_more: !!r.data?.has_more };
  },

  async folderExists(ctx: Ctx<Settings>, path: string): Promise<boolean> {
    try {
      await ctx.draft({ platform: P, op: "files.get_metadata", summary: `check folder ${path}`, input: { params: { path } } });
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false; // path not found
      throw e;
    }
  },

  /** Create a folder when it is missing. Never renames or overwrites anything. */
  async ensureFolder(ctx: Ctx<Settings>, path: string): Promise<void> {
    if (await dropbox.folderExists(ctx, path)) return;
    await ctx.draft({ platform: P, op: "files.create_folder_v2", summary: `create folder ${path}`, input: { params: { path, autorename: false } } });
  },

  /** Move and rename one file by its Dropbox id. Autorename keeps any file already at the target. Returns the new path. */
  async move(ctx: Ctx<Settings>, fromId: string, toPath: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: "files.move_v2", summary: `file to ${toPath}`,
      input: { params: { from_path: fromId, to_path: toPath, autorename: true } } });
    return String(r.data?.metadata?.path_display ?? toPath);
  },

  /** A file request is an upload link for a client or supplier: it reaches outside the business, so it is only ever queued. */
  fileRequest(title: string, destination: string, summary: string, key: string): Act {
    return { platform: P, op: "file_requests.create", summary, key, input: { params: { title: title.slice(0, 120), destination } } };
  },
};
