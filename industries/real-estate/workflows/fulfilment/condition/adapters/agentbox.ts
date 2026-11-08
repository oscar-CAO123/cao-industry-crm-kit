// AgentBox (Reapit Foundations): reads only. The kit maps GET /properties and GET /contacts with no params,
// so these return the first page. Nothing here writes; the document endpoints are a gap (see workflow.json).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Page, type Property, type Contact, ID } from "../types.ts";

const P = "agentbox";
const rows = <T>(data: unknown): T[] => {
  const page = data as Page<T> | undefined;
  return Array.isArray(page?._embedded) ? page!._embedded! : [];
};
const validId = <T extends { id?: unknown }>(x: T) => typeof x?.id === "string" && ID.test(x.id);

export const agentbox = {
  async properties(ctx: Ctx<Settings>): Promise<Property[]> {
    const r = await ctx.draft<Page<Property>>({ platform: P, op: "get:/properties", summary: "read properties" });
    return rows<Property>(r.data).filter(validId);
  },
  async contacts(ctx: Ctx<Settings>): Promise<Contact[]> {
    const r = await ctx.draft<Page<Contact>>({ platform: P, op: "get:/contacts", summary: "read contacts" });
    return rows<Contact>(r.data).filter(validId);
  },
};
