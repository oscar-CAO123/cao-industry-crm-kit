// Google Workspace: existing Google Docs in one Drive folder, read only. A Doc's text is read so the agent can search it
// and write from it. Nothing is created, shared or moved here: entries are drafted in Confluence.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Source, DRIVE_ID, keyOf, oneLine, plain } from "../types.ts";

const P = "google-workspace";

/** Text from every paragraph and table cell of a Doc body, in reading order. */
function bodyText(els: any[]): string {
  let out = "";
  for (const el of els ?? []) {
    for (const e of el.paragraph?.elements ?? []) out += e.textRun?.content ?? "";
    for (const row of el.table?.tableRows ?? []) for (const c of row.tableCells ?? []) out += bodyText(c.content ?? []);
    if (el.tableOfContents) out += bodyText(el.tableOfContents.content ?? []);
  }
  return out;
}

export const googleWorkspace = {
  id: P,
  /** Google Docs in the knowledge folder, up to the set maximum. Read only. Drive does not return a modified date
   *  through the mapped parameters, so these sources are never flagged as stale. */
  async sources(ctx: Ctx<Settings>): Promise<Omit<Source, "status">[]> {
    const folder = ctx.settings.google?.folder_id;
    if (!folder) return [];
    if (!DRIVE_ID.test(folder)) throw new Error("knowledge-base: google.folder_id is not a valid id");
    const max = Math.min(Math.max(Number(ctx.settings.google?.max_docs ?? 25), 1), 50);
    const list = await ctx.draft<any>({ platform: P, op: "drive.files.list", summary: "list docs in the knowledge folder", input: { params: {
      q: `'${folder}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`, pageSize: max, orderBy: "modifiedTime desc" } } });
    const out: Omit<Source, "status">[] = [];
    for (const f of (list.data?.files ?? []).slice(0, max)) {
      if (!DRIVE_ID.test(String(f.id ?? ""))) continue;
      const doc = await ctx.draft<any>({ platform: P, op: "docs.documents.get", summary: "read a doc in the knowledge folder", input: { params: { documentId: String(f.id) } } });
      out.push({ id: keyOf(`google:${f.id}`), platform: P, title: oneLine(f.name ?? doc.data?.title ?? "Existing doc", 200),
        text: plain(bodyText(doc.data?.body?.content ?? [])), seen: ctx.now.toISOString(), ref: { file_id: String(f.id) } });
    }
    return out;
  },
};
