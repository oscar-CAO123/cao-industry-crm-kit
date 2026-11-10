// Cliniko: the practice's treatment note. A session becomes a DRAFT note (draft: true). Saving it as final (draft: false)
// locks it in Cliniko, so that one write is a live operation and only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Platform, type Section, type Session, type Settings } from "../types.ts";

const P: Platform = "cliniko";
const ID = /^\d{1,18}$/;
const id = (v: unknown, what: string) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error(`cliniko: bad ${what}`); return s; };
const text = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
/** Plain text in, escaped HTML paragraphs out (Cliniko accepts p, br, ul, ol, li, blockquote and div in answers). */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const paragraphs = (s: string) => text(s, 20000).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${esc(p.replace(/\s*\n\s*/g, " "))}</p>`).join("");

export function noteContent(sections: Section[]) {
  return {
    sections: sections.slice(0, 50).map((sec) => ({
      name: esc(text(sec.name, 200)),
      description: esc(text(sec.description, 500)),
      questions: (sec.questions ?? []).slice(0, 100).map((q) => ({ name: esc(text(q.name, 200)), type: "text", answer: paragraphs(q.answer) })),
    })),
  };
}

/** Create the note as a draft against the patient and visit. The clinician finishes it in Cliniko before any lock. */
export async function createDraftNote(ctx: Ctx<Settings>, s: Session): Promise<string> {
  const template = s.template_id || ctx.settings.default_template_id;
  const body = {
    patient_id: id(s.patient_id, "patient id"),
    title: esc(text(s.title, 200)),
    draft: true,
    content: noteContent(s.sections),
    ...(s.attendee_id ? { attendee_id: id(s.attendee_id, "attendee id") } : {}),
    ...(s.booking_id ? { booking_id: id(s.booking_id, "booking id") } : {}),
    ...(template ? { treatment_note_template_id: id(template, "template id") } : {}),
  };
  const r = await ctx.draft<any>({ platform: P, op: "treatment-note.createtreatmentnote", summary: `draft treatment note for session ${s.id}`, input: { body } });
  return id(r.data?.id, "note id");
}

/** Read the note back: true while it is still a draft, false once someone has finalised it in Cliniko. */
export async function stillDraft(ctx: Ctx<Settings>, s: Session): Promise<boolean | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "treatment-note.gettreatmentnote", summary: `check note for session ${s.id}`, input: { params: { id: id(s.note_id, "note id") } } });
  return typeof r.data?.draft === "boolean" ? r.data.draft : undefined;
}

/** The lock: save the note as final. Only ever queued; it runs when a person approves it. */
export function finaliseAct(s: Session): Act {
  return {
    platform: P, op: "treatment-note.updatetreatmentnote", key: `sign:${s.id}`,
    summary: `Finalise treatment note for session ${s.id} in Cliniko (locks it)`,
    input: { params: { id: id(s.note_id, "note id") }, body: { draft: false } },
  };
}
