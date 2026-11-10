// Microsoft 365: service health per service, and the open issues of any service that is not healthy. The alert email is
// drafted in the client's own mailbox; its send is returned as an act for the caller to queue for approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Check, type Settings, EMAIL, SERVICE, oneLine } from "../types.ts";

const P = "microsoft-365";
const MSG_ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

export const microsoft365: Adapter & {
  alertDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }>;
} = {
  id: P,
  async checks(ctx: Ctx<Settings>): Promise<Omit<Check, "seen" | "alerted">[]> {
    const out: Omit<Check, "seen" | "alerted">[] = [];
    const health = await ctx.draft<any>({ platform: P, op: "admin.serviceAnnouncement.ListHealthOverviews", summary: "read Microsoft 365 service health" });
    for (const h of health.data?.value ?? []) {
      const id = String(h.id ?? "");
      if (!SERVICE.test(id)) continue;
      const name = oneLine(h.service || id, 120);
      const status = String(h.status ?? "unknown");
      const ok = status === "serviceOperational";
      let reason: string | undefined;
      if (!ok) {
        const iss = await ctx.draft<any>({ platform: P, op: "admin.serviceAnnouncement.healthOverviews.ListIssues", summary: `read open issues for ${name}`, input: { params: { "serviceHealth-id": id, $top: 3 } } });
        const open = (iss.data?.value ?? []).filter((x: any) => x.isResolved !== true).map((x: any) => oneLine(x.title, 120)).filter(Boolean);
        reason = `status is ${status}` + (open.length ? `: ${open.join("; ")}` : "");
      }
      out.push({ key: `microsoft-365:service:${id}`, platform: P, kind: "service", name, ok, reason });
    }
    return out;
  },
  /** Create the alert email as a draft in the client's mailbox, and return the send act for the caller to queue. */
  async alertDraft(ctx, m) {
    const box = ctx.settings.microsoft_365?.mailbox;
    if (!box || !EMAIL.test(box)) throw new Error("systems-monitoring: microsoft_365.mailbox is not set");
    if (!EMAIL.test(m.to)) throw new Error("systems-monitoring: alert_to is not a valid address");
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft alert to ${m.to}`, input: { params: { "user-id": box }, body: {
      subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!MSG_ID.test(id)) throw new Error("systems-monitoring: alert draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send alert to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
  },
};
