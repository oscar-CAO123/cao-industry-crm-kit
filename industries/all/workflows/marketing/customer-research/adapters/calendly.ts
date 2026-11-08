// Calendly: survey answers from a routing form. Read only: the workflow never changes a Calendly form, contact or booking.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Response, type Answer, type Settings, EMAIL, keyFor } from "../types.ts";

const P = "calendly";
const FORM = /^https:\/\/api\.calendly\.com\/routing_forms\/[A-Za-z0-9-]{4,80}$/;
const SUBMISSION = /^https:\/\/api\.calendly\.com\/routing_form_submissions\/[A-Za-z0-9-]{4,80}$/;

export const calendly = {
  /** Every submission to the routing form, page by page (Calendly's next_page_token). */
  async responses(ctx: Ctx<Settings>, formUri: string): Promise<Response[]> {
    if (!FORM.test(formUri)) throw new Error("calendly: not a routing form URI");
    const out: Response[] = [];
    let page: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await ctx.draft<any>({ platform: P, op: "api.routingForms_list-routing-form-submissions", summary: "read routing form submissions",
        input: { params: { form: formUri, count: 100, ...(page ? { page_token: page } : {}) } } });
      for (const x of r.data?.collection ?? []) {
        const uri = String(x?.uri ?? "");
        if (!SUBMISSION.test(uri)) continue;
        const answers: Answer[] = (x.questions_and_answers ?? []).map((q: any) => ({
          question: String(q?.question ?? "Question").slice(0, 200),
          answer: String(q?.answer ?? "").trim().slice(0, 2000),
        }));
        const email = answers.map((a) => a.answer).find((a) => EMAIL.test(a));
        out.push({ key: keyFor("c", uri), source: "calendly", received: String(x.created_at ?? ctx.now.toISOString()), email, answers });
      }
      page = r.data?.pagination?.next_page_token ?? undefined;
      if (!page) break;
    }
    return out;
  },
};
