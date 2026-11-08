// Bluebeam Studio: the approval document's markups and RFI-style requests, its valid statuses, and a dated snapshot.
// Every call here is a draft operation: reads, plus a snapshot kept inside the Studio session. None changes a status.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Document, MarkupRow, Settings } from "../types.ts";

const P = "bluebeam";
const short = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export const bluebeam = {
  id: P,
  /** The files in the Studio session, to confirm the approval document is still there. */
  async files(ctx: Ctx<Settings>, d: Document): Promise<{ Id: number; Name?: string; Status?: string }[]> {
    const r = await ctx.draft<any>({ platform: P, op: "SessionFiles_GetAll", summary: `read session files for ${d.label ?? "document"}`,
      input: { params: { sessionId: d.session_id, limit: 50 } } });
    return Array.isArray(r.data?.Files) ? r.data.Files : [];
  },
  /** Markups on the document: subject, status and page. Their text is data from outside the business. */
  async markups(ctx: Ctx<Settings>, d: Document): Promise<MarkupRow[]> {
    const r = await ctx.draft<any>({ platform: P, op: "SessionMarkups_Get", summary: `read markups for ${d.label ?? "document"}`,
      input: { params: { sessionId: d.session_id, fileId: d.file_id } } });
    const rows: any[] = Array.isArray(r.data) ? r.data.slice(0, 500) : [];
    return rows.map((x) => ({
      id: short(x.markupId ?? x.Id, 120),
      subject: short(x.subject ?? x.Subject, 200),
      status: short(x.status ?? x.Status, 60),
      page: Number.isInteger(x.pageNumber) ? x.pageNumber : undefined,
    })).filter((x) => x.id);
  },
  /** The valid markup statuses for the document, as the API lists them. */
  async statuses(ctx: Ctx<Settings>, d: Document): Promise<number> {
    const r = await ctx.draft<any>({ platform: P, op: "SessionMarkupsStatus_Get", summary: "read valid markup statuses",
      input: { params: { sessionId: d.session_id, fileId: d.file_id } } });
    return Array.isArray(r.data) ? r.data.length : 0;
  },
  /** Start a dated snapshot of the document inside the session, for the record. */
  async snapshot(ctx: Ctx<Settings>, d: Document) {
    return ctx.draft<any>({ platform: P, op: "SessionFiles_Snapshot", summary: `snapshot ${d.label ?? "document"} for the record`,
      input: { params: { sessionId: d.session_id, id: Number(d.file_id) } } });
  },
};
