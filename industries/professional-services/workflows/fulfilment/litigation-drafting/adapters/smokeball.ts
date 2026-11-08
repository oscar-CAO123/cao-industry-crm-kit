// Smokeball: where the matter, its documents, its memos and the staff tasks live. Field names come from the vendor's
// OpenAPI spec (docs.smokeball.com). Reads and internal writes are drafts; a portal message to a client is a live
// operation, so this adapter only returns its act for the cron to queue.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Matter, type FileRecord, ID, clean, keyOf } from "../types.ts";

const P = "smokeball";

export const smokeball = {
  id: P,

  /** Lead matters (intake). Each Matter carries its client contact ids for a later portal message. */
  async leadMatters(ctx: Ctx<Settings>): Promise<Matter[]> {
    const params: Record<string, unknown> = { IsLead: true, Limit: 50 };
    if (ctx.settings.lead_matter_type_id) {
      if (!ID.test(ctx.settings.lead_matter_type_id)) throw new Error("smokeball: bad lead_matter_type_id");
      params.MatterTypeId = ctx.settings.lead_matter_type_id;
    }
    const r = await ctx.draft<any>({ platform: P, op: "GetMatters", summary: "read new lead matters", input: { params } });
    return (r.data?.value ?? [])
      .filter((m: any) => ID.test(String(m.id ?? "")))
      .map((m: any): Matter => ({
        id: String(m.id), number: m.number ? clean(m.number, 60) : undefined, title: clean(m.title ?? "Matter", 160),
        status: m.status ? clean(m.status, 40) : undefined,
        clients: (m.clients ?? []).map((c: any) => String(c?.id ?? "")).filter((c: string) => ID.test(c)),
        seen: ctx.now.toISOString(),
      }));
  },

  /** The file list for one matter: names and dates only (the kit classes the download as a write, so content is not read here). */
  async files(ctx: Ctx<Settings>, matterId: string): Promise<FileRecord[]> {
    if (!ID.test(matterId)) throw new Error("smokeball: bad matter id");
    const r = await ctx.draft<any>({ platform: P, op: "GetFiles", summary: `read files of matter ${matterId}`, input: { params: { matterId, Limit: 100 } } });
    return (r.data?.value ?? [])
      .filter((f: any) => ID.test(String(f.id ?? "")))
      .map((f: any): FileRecord => ({
        id: String(f.id), name: clean(f.name ?? "file", 200), ext: f.fileExtension ? clean(f.fileExtension, 10) : undefined,
        created: f.dateCreated ? clean(f.dateCreated, 40) : undefined, modified: f.dateModified ? clean(f.dateModified, 40) : undefined,
        size: Number.isFinite(f.sizeBytes) ? Number(f.sizeBytes) : undefined,
      }));
  },

  /** An internal memo on the matter (draft: nobody outside the practice sees it). */
  async memo(ctx: Ctx<Settings>, matterId: string, title: string, text: string): Promise<string> {
    if (!ID.test(matterId)) throw new Error("smokeball: bad matter id");
    const r = await ctx.draft<any>({ platform: P, op: "CreateMemo", summary: `memo on matter ${matterId}: ${clean(title, 80)}`,
      input: { params: { matterId }, body: { title: clean(title, 250), text: clean(text, 20000) } } });
    return String(r.data?.id ?? "");
  },

  /** An internal task for the solicitor (draft). */
  async task(ctx: Ctx<Settings>, matterId: string, subject: string, note: string): Promise<string> {
    if (!ID.test(matterId) || !ID.test(ctx.settings.solicitor_staff_id)) throw new Error("smokeball: bad matter or staff id");
    const r = await ctx.draft<any>({ platform: P, op: "CreateTask", summary: `task on matter ${matterId}: ${clean(subject, 80)}`,
      input: { body: { matterId, staffId: ctx.settings.solicitor_staff_id, subject: clean(subject, 250), note: clean(note, 4000) } } });
    return String(r.data?.id ?? "");
  },

  /** The act that sends a portal message to a client. Returned for the cron to queue; never run by a cron. */
  clientMessage(matterId: string, contactId: string, message: string, summary: string, draftKey: string): Act {
    if (!ID.test(matterId) || !ID.test(contactId)) throw new Error("smokeball: bad matter or contact id");
    return { platform: P, op: "SendPortalMessageAsync", summary, key: keyOf(`portal-${draftKey}`),
      input: { params: { matterId }, body: { contactId, message: clean(message, 8000) } } };
  },
};
