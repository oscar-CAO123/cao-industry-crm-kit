// Shared shapes for the plant and equipment workflow. Two platforms carry mapped operations for this job:
// Trackunit (the plant register and telematics) and ServiceM8 (the asset list, workshop jobs and their parts).
export interface Settings {
  family: "plant-register";
  owner_email: string;                 // who gets the cost summary (an approval, never sent by a cron)
  business_name?: string;
  workshop_category_uuid?: string;     // ServiceM8 job category for internal workshop repairs; blank = cost-watch reads nothing
  trackunit_page_size?: number;        // 1 to 200 (default 100)
  trackunit_max_pages?: number;        // 1 to 50 (default 10)
  top_jobs?: number;                   // jobs listed in the cost summary (default 10, 1 to 50)
}

/** One plant item from the Trackunit register, matched by name to a ServiceM8 asset when one exists. */
export interface PlantRow {
  key: string; trackunit_id: string; name: string; serial?: string; brand?: string; model?: string; type?: string;
  telematics_devices: number; servicem8_uuid?: string; in_servicem8: boolean; checked: string;
}

/** Parts cost on one ServiceM8 workshop job (ex GST, as entered on the job). */
export interface JobCost { key: string; job_uuid: string; description: string; parts_ex_gst: number; lines: number; checked: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export function checkSettings(s: Settings): void {
  if (s.family !== "plant-register") throw new Error("x-plant: family must be plant-register");
  if (!EMAIL.test(String(s.owner_email ?? ""))) throw new Error("x-plant: owner_email must be an email address");
  if (s.workshop_category_uuid && !UUID.test(s.workshop_category_uuid)) throw new Error("x-plant: workshop_category_uuid must be a ServiceM8 uuid");
  const size = s.trackunit_page_size ?? 100, pages = s.trackunit_max_pages ?? 10, top = s.top_jobs ?? 10;
  if (!(Number.isInteger(size) && size >= 1 && size <= 200)) throw new Error("x-plant: trackunit_page_size must be 1 to 200");
  if (!(Number.isInteger(pages) && pages >= 1 && pages <= 50)) throw new Error("x-plant: trackunit_max_pages must be 1 to 50");
  if (!(Number.isInteger(top) && top >= 1 && top <= 50)) throw new Error("x-plant: top_jobs must be 1 to 50");
}

export const round = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Names are compared trimmed, lower case and with single spaces. */
export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
