// Dropbox: the files in one job folder (a read). Nothing is uploaded, moved or deleted; the folder structure stays with the business.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, DBX_PATH } from "../types.ts";

export interface JobFile { name: string; path: string; modified: string }

/** The files in one job folder (a read, not recursive). */
export async function listJob(ctx: Ctx<Settings>, folder: string): Promise<{ files: JobFile[]; more: boolean }> {
  if (!DBX_PATH.test(folder)) throw new Error("dropbox: bad job folder path (it must start with /)");
  const r = await ctx.draft<any>({ platform: "dropbox", op: "files.list_folder", summary: `list ${folder}`, input: {
    body: { path: folder, recursive: false, limit: 200 } } });
  const entries: any[] = Array.isArray(r.data?.entries) ? r.data.entries : [];
  return {
    files: entries.filter((e) => e?.[".tag"] === "file").map((e) => ({
      name: String(e.name ?? "").slice(0, 200), path: String(e.path_display ?? "").slice(0, 500), modified: String(e.server_modified ?? "").slice(0, 25),
    })),
    more: r.data?.has_more === true,
  };
}
