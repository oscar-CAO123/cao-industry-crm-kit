// Cliniko: the appointment book. Field names come from Cliniko's API docs (IndividualAppointment, filter list in
// the list operation). Reads go through ctx.draft; the one write (booking a waitlisted patient) is only ever queued.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Appt, type Settings } from "../types.ts";

const P = "cliniko";
const LIST = "individual-appointment.listindividualappointments";
const DIGITS = /^\d{1,12}$/;
const PAGE = 100, MAX_PAGES = 10;

/** Cliniko filter values: a date-time without milliseconds. */
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Keep only the fields this workflow reads, and refuse rows that do not look like an appointment. */
function clean(row: any): Appt | undefined {
  const id = String(row?.id ?? "");
  if (!DIGITS.test(id) || typeof row?.starts_at !== "string" || Number.isNaN(Date.parse(row.starts_at))) return undefined;
  const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v).slice(0, 200));
  const d = (v: unknown) => (DIGITS.test(String(v ?? "")) ? String(v) : undefined);
  return {
    id, starts_at: row.starts_at, ends_at: s(row.ends_at),
    patient_id: d(row.patient_id), patient_name: s(row.patient_name),
    appointment_type_id: d(row.appointment_type_id), practitioner_id: d(row.practitioner_id), business_id: d(row.business_id),
    cancelled_at: row.cancelled_at ?? null, archived_at: row.archived_at ?? null, deleted_at: row.deleted_at ?? null,
    did_not_arrive: row.did_not_arrive === true, sms_reminder_sent: row.sms_reminder_sent === true,
    email_reminder_sent: row.email_reminder_sent === true,
  };
}

export const cliniko: Adapter = {
  id: P,
  /**
   * Individual appointments that start between from and to, cancelled ones included (the cron reads cancelled_at).
   * The SDK sends an array filter as one JSON string, so only the start filter goes to Cliniko; the end bound and
   * the business are checked here. A book bigger than MAX_PAGES pages is refused, never read partly.
   */
  async appointments(ctx: Ctx<Settings>, from: Date, to: Date) {
    const biz = ctx.settings.business_id || undefined;
    if (biz && !DIGITS.test(biz)) throw new Error("cliniko: business_id must be digits");
    const out: Appt[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await ctx.draft<{ individual_appointments?: any[]; total_entries?: number }>({
        platform: P, op: LIST,
        input: { params: { page, per_page: PAGE, "q[]": `starts_at:>=${stamp(from)}` } },
        summary: `read Cliniko appointments page ${page}`,
      });
      const rows = Array.isArray(r.data?.individual_appointments) ? r.data!.individual_appointments! : [];
      const total = Number(r.data?.total_entries ?? 0);
      if (page === 1 && total > MAX_PAGES * PAGE) throw new Error(`cliniko: ${total} future appointments is more than one read covers; a runtime change is needed`);
      for (const row of rows) {
        const a = clean(row);
        if (a && Date.parse(a.starts_at) <= to.getTime() && (!biz || a.business_id === biz)) out.push(a);
      }
      if (rows.length < PAGE || page * PAGE >= total) return out;
    }
    return out;
  },
};
