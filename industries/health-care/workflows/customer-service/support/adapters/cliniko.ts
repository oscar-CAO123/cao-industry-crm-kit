// Cliniko: the clinic's patient records. This workflow only reads here: it finds the enquirer's record so the approver
// sees who is writing in. Bookings, patient writes and clinical notes stay with staff. Field names from Cliniko's
// official spec (patient.listpatients, response key "patients").
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Contact, EMAIL, cap } from "../types.ts";

export interface Matched { id: string; matched_by: "email" | "name" }

/** One record: found by email, or by a first and last name that match exactly one record. Zero or several is no match. */
export async function findPatient(ctx: Ctx<Settings>, c: Contact): Promise<Matched | undefined> {
  const email = c.email && EMAIL.test(c.email) ? c.email : undefined;
  let params: Record<string, string>;
  let by: "email" | "name";
  if (email) { params = { email }; by = "email"; }
  else {
    const parts = cap(c.name, 120).split(" ").filter(Boolean);
    if (parts.length < 2) return undefined;
    params = { first_name: parts[0].slice(0, 60), last_name: parts[parts.length - 1].slice(0, 60) };
    by = "name";
  }
  const r = await ctx.draft<{ patients?: { id: number | string; email?: string }[] }>({ platform: "cliniko", op: "patient.listpatients",
    summary: "find patient record", input: { params } });
  const hits = (r.data?.patients ?? []).filter((p) => /^\d{1,12}$/.test(String(p.id))
    && (by !== "email" || String(p.email ?? "").toLowerCase() === email!.toLowerCase()));
  return hits.length === 1 ? { id: String(hits[0].id), matched_by: by } : undefined;
}
