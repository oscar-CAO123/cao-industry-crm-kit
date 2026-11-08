// DocuSign: envelopes out for signature and each signer's status. Read only. Reminders go out through the
// client's mailbox (microsoft-365), so nothing here can send.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Envelope, type Settings, type Signer } from "../types.ts";

const P = "docusign";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Envelopes sent in the look-back window, with their signers. Pages through up to 1,000 envelopes a run. */
export async function envelopes(ctx: Ctx<Settings>): Promise<Envelope[]> {
  const days = Math.min(Math.max(Math.round(ctx.settings.docusign?.from_days ?? 90), 1), 365);
  const from = ymd(new Date(ctx.now.getTime() - days * 864e5));
  const out: Envelope[] = [];
  for (let start = 0; start < 1000; start += 100) {
    const r = await ctx.draft<any>({ platform: P, op: "esignature.Envelopes_GetEnvelopes", summary: "read envelopes out for signature", input: { params: {
      from_date: from, status: "sent,delivered,completed", include: "recipients", count: 100, start_position: start } } });
    const page: any[] = r.data?.envelopes ?? [];
    for (const e of page) {
      if (!UUID.test(String(e.envelopeId ?? ""))) continue;
      const signers: Signer[] = (e.recipients?.signers ?? []).map((s: any) => ({
        name: String(s.name ?? "").slice(0, 120), email: String(s.email ?? "").toLowerCase().slice(0, 190), status: String(s.status ?? ""),
        signedDateTime: s.signedDateTime ?? null, routingOrder: s.routingOrder ?? null }));
      out.push({ id: e.envelopeId, subject: String(e.emailSubject ?? "Agreement").slice(0, 200), status: String(e.status ?? ""),
        sent: e.sentDateTime ?? null, signers, reminders: [] });
    }
    if (page.length < 100) break;
  }
  return out;
}
