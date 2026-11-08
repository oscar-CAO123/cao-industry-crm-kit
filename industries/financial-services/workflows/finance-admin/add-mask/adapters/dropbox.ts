// Dropbox: where the client documents and their masked copies live. The crons list folders and read who can see a file
// (draft operations, inside the business's Dropbox). Giving a person access reaches outside the business, so it is only ever queued.
// Field names come from the Dropbox API spec mapped in core/sdk/platforms/dropbox/ops.json (sharing.stone, files.stone).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "dropbox";

export interface Entry { ".tag": string; id: string; name: string; path_display?: string; server_modified?: string }

export const dropbox = {
  id: P,

  /** The first page of a folder's files (folders are skipped). */
  async listFolder(ctx: Ctx<Settings>, path: string): Promise<{ files: Entry[]; has_more: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "files.list_folder", summary: `list ${path}`, input: { params: { path } } });
    const files = ((r.data?.entries ?? []) as Entry[]).filter((e) => e[".tag"] === "file");
    return { files, has_more: !!r.data?.has_more };
  },

  /** Every user and invitee who can see a file, by lower-case email. Groups are not read (see gaps). */
  async emailsWithAccess(ctx: Ctx<Settings>, file: string): Promise<string[]> {
    const r = await ctx.draft<any>({ platform: P, op: "sharing.list_file_members", summary: `who can see ${file}`,
      input: { params: { file, limit: 300 } } });
    const users = ((r.data?.users ?? []) as any[]).map((u) => u.user?.email);
    const invitees = ((r.data?.invitees ?? []) as any[]).map((i) => (i.invitee?.[".tag"] === "email" ? i.invitee.email : undefined));
    return [...users, ...invitees].filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase());
  },

  /** A view share of one file to one email address. quiet: Dropbox sends no invitation; the owner writes to the recipient. */
  share(file: string, email: string, key: string): Act {
    return { platform: P, op: "sharing.add_file_member", key, summary: `give ${email} view access to ${file}`,
      input: { params: { file, members: [{ ".tag": "email", email }], access_level: { ".tag": "viewer" }, quiet: true } } };
  },
};
