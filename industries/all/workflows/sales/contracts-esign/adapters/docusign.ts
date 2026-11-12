// DocuSign: where the agreement is signed. An agreement becomes a DRAFT envelope (status "created": DocuSign emails
// no one), and sending it is a live operation that only runs after a person approves it. Operation ids are in
// core/sdk/platforms/docusign/ops.json. Field names (emailSubject, documents, recipients.signers, routingOrder) are
// from DocuSign's eSignature spec. The account id is filled from DOCUSIGN_ACCOUNT_ID by the SDK.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Agreement, type Settings, cleanText, GUID } from "../types.ts";

export const P = "docusign";
export const OP_CREATE = "esignature.Envelopes_PostEnvelopes";
export const OP_READ = "esignature.Envelopes_GetEnvelope";
export const OP_SEND = "esignature.Envelopes_PutEnvelope";

/** The envelope as DocuSign takes it. Status is always "created": a draft that nobody is emailed about. */
export function envelopeBody(s: Settings, a: Agreement) {
  return {
    status: "created" as const,
    emailSubject: cleanText(`${s.email_subject_prefix ?? "Please sign"}: ${a.title}`, 100),
    documents: [{ documentBase64: a.document.base64.replace(/\s/g, ""), name: cleanText(a.document.name, 100), fileExtension: "pdf", documentId: "1" }],
    recipients: { signers: a.signers.map((x, i) => ({ name: cleanText(x.name, 100), email: x.email, recipientId: String(i + 1), routingOrder: String(i + 1) })) },
  };
}

/** Saves the agreement as a draft envelope and returns its id. Nothing is sent. */
export async function createDraft(ctx: Ctx<Settings>, a: Agreement): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: OP_CREATE, summary: `draft envelope: ${a.title}`, input: { body: envelopeBody(ctx.settings, a) } });
  const id = String(r.data?.envelopeId ?? "");
  if (!GUID.test(id)) throw new Error("docusign: draft envelope was not created");
  return id;
}

/** The send, as an act for a person to approve. Changing a draft envelope to sent emails every signer. */
export function sendAct(a: Agreement): Act {
  if (!a.envelope || !GUID.test(a.envelope)) throw new Error("docusign: agreement has no draft envelope");
  return { platform: P, op: OP_SEND, key: `send:${a.id}`, summary: `send for signature: ${a.title}`,
    input: { params: { envelopeId: a.envelope }, body: { status: "sent" } } };
}

/** Reads one envelope's status (a read). */
export async function fetchStatus(ctx: Ctx<Settings>, envelope: string): Promise<{ status: string; completedDateTime?: string }> {
  if (!GUID.test(envelope)) throw new Error("docusign: bad envelope id");
  const r = await ctx.draft<any>({ platform: P, op: OP_READ, summary: "read envelope status", input: { params: { envelopeId: envelope, include: "recipients" } } });
  const done = r.data?.completedDateTime;
  return { status: String(r.data?.status ?? ""), completedDateTime: done ? String(done) : undefined };
}
