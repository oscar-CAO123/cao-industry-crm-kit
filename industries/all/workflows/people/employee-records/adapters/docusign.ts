// DocuSign: the employment contract as an envelope from the business's own template. Reading the template is a draft
// read. Sending the envelope to the new employee is live and waits for a person to approve it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, NAME, check, hireProblem, type Settings, type Hire } from "../types.ts";

const P = "docusign";

export const docusign = {
  id: P,

  /** Read the contract template to confirm it exists before a contract is queued. Draft read. */
  async readTemplate(ctx: Ctx<Settings>) {
    const id = ctx.settings.docusign?.template_id ?? "";
    check(ID.test(id), "docusign.template_id is not set");
    const r = await ctx.draft<any>({ platform: P, op: "esignature.Templates_GetTemplate", summary: "read contract template",
      input: { params: { templateId: id } } });
    check(r.status < 300, `contract template was not read (status ${r.status})`);
    return r.data;
  },

  /** Queue the envelope that sends the template to the employee for signature. Live: it sends an email. */
  queueContract(ctx: Ctx<Settings>, h: Hire) {
    const bad = hireProblem(h);
    check(!bad, bad ?? "");
    const role = ctx.settings.docusign?.role_name ?? "";
    check(NAME.test(role), "docusign.role_name is not set");
    const tpl = ctx.settings.docusign.template_id;
    check(ID.test(tpl), "docusign.template_id is not set");
    return ctx.queue({
      platform: P, op: "esignature.Envelopes_PostEnvelopes", key: `contract:${h.id}`, summary: `contract envelope for ${h.first_name} ${h.last_name}`,
      input: { body: {
        emailSubject: "Please sign your employment contract",
        templateId: tpl,
        status: "sent",
        templateRoles: [{ email: h.email, name: `${h.first_name} ${h.last_name}`, roleName: role }],
      } },
    }, `send the employment contract to ${h.email} for signature`);
  },
};
