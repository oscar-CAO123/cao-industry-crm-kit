// Google Workspace: the forms that clients fill in. Responses are read through the Forms API (fields confirmed in the
// vendor spec: responseId, lastSubmittedTime, respondentEmail, answers keyed by questionId with textAnswers.answers[].value).
// A chase is a Gmail draft (a draft operation). Its send is only ever queued for a person to approve.
import type { Act, Check, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { EMAIL, esc } from "../../../../../construction/workflows/sales/quoting/types.ts";
import type { Settings } from "../types.ts";

const P = "google-workspace";
const FORM = /^[A-Za-z0-9_-]{1,100}$/;
const QUESTION = /^[A-Za-z0-9_-]{1,64}$/;
const RESPONSE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_PAGES = 10;

export interface Response { response_id: string; form_id: string; seen: string; email?: string; answers: Record<string, string> }

export const google = {
  id: P,
  /** Every response to one form, newest pages included (up to MAX_PAGES x 100). A draft operation. */
  async responses(ctx: Ctx<Settings>, formId: string): Promise<Response[]> {
    if (!FORM.test(formId)) throw new Error("google-workspace: bad form id");
    const out: Response[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, unknown> = token ? { formId, pageSize: 100, pageToken: token } : { formId, pageSize: 100 };
      const r = await ctx.draft<any>({ platform: P, op: "forms.forms.responses.list", summary: `read responses to form ${formId}`, input: { params } });
      for (const x of r.data?.responses ?? []) {
        const id = String(x.responseId ?? "");
        if (!RESPONSE.test(id)) continue;
        const answers: Record<string, string> = {};
        for (const [qid, a] of Object.entries<any>(x.answers ?? {})) {
          if (!QUESTION.test(qid)) continue;
          const v = (a?.textAnswers?.answers ?? []).map((t: any) => String(t?.value ?? "")).filter(Boolean).join(", ");
          if (v) answers[qid] = v.slice(0, 2000);
        }
        out.push({ response_id: id, form_id: formId, seen: String(x.lastSubmittedTime ?? x.createTime ?? ctx.now.toISOString()),
          email: EMAIL.test(x.respondentEmail ?? "") ? x.respondentEmail : undefined, answers });
      }
      token = r.data?.nextPageToken ? String(r.data.nextPageToken) : undefined;
      if (!token) break;
    }
    return out;
  },
  /** A Gmail draft to the client. The address is checked, and the subject cannot carry a line break into the headers. */
  async chaseDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
    if (!EMAIL.test(to)) throw new Error("google-workspace: bad recipient");
    const head = subject.replace(/[\r\n]+/g, " ").slice(0, 200);
    const mime = [`To: ${to}`, `Subject: ${head}`, "MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "", html].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft chase email to ${to}`,
      input: { params: { userId: "me" }, body: { message: { raw } } } });
    const id = String(r.data?.id ?? "");
    if (!RESPONSE.test(id)) throw new Error("google-workspace: draft not created");
    return id;
  },
  /** The live act a person approves: send one Gmail draft. Never run by a cron. The check re-reads the response at approval. */
  sendAct(draftId: string, to: string, key: string, check?: Check): Act {
    if (!RESPONSE.test(draftId)) throw new Error("google-workspace: bad draft id");
    return { platform: P, op: "gmail.users.drafts.send", summary: `send chase email to ${to}`, key, check, input: { params: { userId: "me" }, body: { id: draftId } } };
  },
};

/** The check on a chase: the response must still carry the last-submitted time the cron read, so an answer given since
 *  the chase was queued stops it. A draft operation (forms.forms.responses.get). */
export function responseCheck(formId: string, responseId: string, seen: string): Check {
  if (!FORM.test(formId) || !RESPONSE.test(responseId)) throw new Error("google-workspace: bad form or response id");
  return { platform: P, op: "forms.forms.responses.get", input: { params: { formId, responseId } }, expect: [{ path: "lastSubmittedTime", equals: seen }] };
}

/** The chase body: escaped, plain, listing exactly what is missing. */
export const chaseHtml = (business: string, label: string, missing: string[]) =>
  `<p>Hi there,</p><p>Thanks for your ${esc(label)}. We still need the following before we can go further:</p>`
  + `<ul>${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
  + `<p>Reply to this email with those details.</p><p>${esc(business)}</p>`;
