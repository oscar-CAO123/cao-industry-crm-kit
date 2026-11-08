// Cliniko: the GP letter is a DRAFT treatment note on the patient (draft: true), which the practice finishes and sends
// from its own system. The results-review recall is a live operation: Cliniko texts the patient from a recall, so it is
// only ever queued for a person to approve.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { type Platform, type Result, type Settings } from "../types.ts";

const P: Platform = "cliniko";
const ID = /^\d{1,18}$/;
const id = (v: unknown, what: string) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error(`cliniko: bad ${what}`); return s; };
const text = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Plain text in, escaped HTML paragraphs out (Cliniko accepts p, br, ul, ol, li, blockquote and div in answers). */
export const paragraphs = (s: string) => text(s, 20000).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p.replace(/\s*\n\s*/g, " "))}</p>`).join("");

/** The day the results review is due: the filed date plus the review interval. */
export function reviewAt(r: Result, s: Settings): string {
  const days = Number.isFinite(s.review_after_days) && s.review_after_days! > 0 ? s.review_after_days! : 7;
  const filed = Date.parse(r.filed);
  if (!Number.isFinite(filed)) throw new Error("cliniko: bad filed date");
  return new Date(filed + days * 864e5).toISOString();
}

/** Save the GP letter as a draft note against the patient. Nothing is sent and nothing is finalised. */
export async function createDraftNote(ctx: Ctx<Settings>, r: Result): Promise<string> {
  const template = ctx.settings.default_template_id;
  const body = {
    patient_id: id(r.patient_id, "patient id"),
    title: text("Letter to GP: result review", 200),
    draft: true,
    content: {
      sections: [{ name: "Letter to GP", description: "", questions: [{ name: "Letter", type: "text", answer: paragraphs(r.letter ?? "") }] }],
    },
    ...(template ? { treatment_note_template_id: id(template, "template id") } : {}),
  };
  const res = await ctx.draft<any>({ platform: P, op: "treatment-note.createtreatmentnote", summary: `draft GP letter note for result ${r.id}`, input: { body } });
  return id(res.data?.id, "note id");
}

/** The results-review recall. Only ever queued: it runs when a person approves it, because Cliniko texts the patient from it. */
export function recallAct(r: Result, s: Settings): Act {
  const when = reviewAt(r, s);
  return {
    platform: P, op: "recall.createrecall", key: `recall:${r.id}`,
    summary: `Create a results-review recall in Cliniko for patient ${r.patient_id} on ${when.slice(0, 10)} (Cliniko texts the patient)`,
    input: { body: { patient_id: id(r.patient_id, "patient id"), recall_type_id: id(s.result_review_recall_type_id, "recall type id"), recall_at: when, notes: "Results review" } },
  };
}
