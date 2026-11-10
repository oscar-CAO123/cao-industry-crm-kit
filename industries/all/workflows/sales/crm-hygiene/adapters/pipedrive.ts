// Pipedrive: persons are the records. Field names are from Pipedrive's official specs: openapi-v2 GET /api/v2/persons
// (limit, cursor; data[].id, data[].emails[].value, data[].add_time; additional_data.next_cursor), GET and PATCH
// /api/v2/persons/{id} (emails[]), and v1 PUT /v1/persons/{id}/merge (merge_with_id). The path id is the person merged
// away and merge_with_id is the person kept: read from the spec wording, not yet proven on a sandbox.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ApiError } from "../../../../../../core/lib/http.ts";
import { type Adapter, type Contact, type Finding, type Settings, ID, norm, tidy, valid } from "../types.ts";

const P = "pipedrive" as const;
const PAGE = 100;
const LIST = "openapi-v2.getPersons";
const GET = "openapi-v2.getPerson";
const PATCH = "openapi-v2.updatePerson";
const MERGE = "docs_api_v1.mergePersons";

/** The email entries a person holds, as the CRM returns them. */
const entries = (list: unknown): any[] => Array.isArray(list) ? list : [];

/** The valid addresses a person holds, normalised. undefined when the person is gone (a merged or deleted record). */
async function currentEmails(ctx: Ctx<Settings>, id: string): Promise<string[] | undefined> {
  try {
    const r = await ctx.draft<any>({ platform: P, op: GET, summary: `re-read person ${id} before merging`,
      input: { params: { id: Number(id) } } });
    return entries(r.data?.data?.emails).map((e) => norm(e?.value)).filter(valid);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

export const pipedrive: Adapter = {
  id: P,

  async page(ctx: Ctx<Settings>, cursor?: string) {
    if (cursor !== undefined && !/^[A-Za-z0-9_=-]{1,500}$/.test(cursor)) throw new Error("crm-hygiene: pipedrive cursor is not a plain token");
    const r = await ctx.draft<any>({ platform: P, op: LIST, summary: "read a page of persons",
      input: { params: { limit: PAGE, ...(cursor ? { cursor } : {}) } } });
    const items: Contact[] = (Array.isArray(r.data?.data) ? r.data.data : [])
      .filter((p: any) => ID.test(String(p?.id ?? "")))
      .map((p: any) => ({
        id: String(p.id),
        emails: entries(p.emails).map((e) => String(e?.value ?? "")).filter(Boolean),
        created: String(p.add_time ?? ""),
      }))
      .filter((c: Contact) => c.emails.length > 0);
    const next = r.data?.additional_data?.next_cursor;
    return { items, next: next ? String(next) : undefined };
  },

  async queueMerge(ctx: Ctx<Settings>, f: Finding, key: string): Promise<string | undefined> {
    if (!ID.test(f.id) || !f.with || !ID.test(f.with)) throw new Error("crm-hygiene: merge needs two plain record ids");
    // Re-read both persons: the scan may be days old. The merge is queued only while they still share an address.
    const a = await currentEmails(ctx, f.id), b = await currentEmails(ctx, f.with);
    if (!a || !b || !a.some((e) => b.includes(e))) return undefined;
    return ctx.queue({ platform: P, op: MERGE, key, summary: f.summary,
      input: { params: { id: Number(f.id) }, body: { merge_with_id: Number(f.with) } } }, f.summary);
  },

  async queueTidy(ctx: Ctx<Settings>, f: Finding, key: string) {
    if (!ID.test(f.id)) throw new Error("crm-hygiene: tidy needs a plain record id");
    const r = await ctx.draft<any>({ platform: P, op: GET, summary: `re-read person ${f.id} before tidying its emails`,
      input: { params: { id: Number(f.id) } } });
    const current = entries(r.data?.data?.emails);
    let changed = false;
    const next = current.map((e) => {
      if (!e || typeof e.value !== "string") return e;
      const t = tidy(e.value);
      if (t !== e.value) changed = true;
      return { ...e, value: t };
    });
    if (!changed) return undefined;
    const summary = `Tidy the email address on person ${f.id} (trim and lowercase)`;
    return ctx.queue({ platform: P, op: PATCH, key, summary,
      input: { params: { id: Number(f.id) }, body: { emails: next } } }, summary);
  },
};
