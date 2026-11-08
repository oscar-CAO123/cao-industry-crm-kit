// DocuSign helper: envelopes from a template, their status, and the signed copy.
// Keys: DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID (the user the app acts as), DOCUSIGN_ACCOUNT_ID,
// DOCUSIGN_PRIVATE_KEY (PEM), and DOCUSIGN_ENV=demo for the free developer sandbox.
// The CRM found one service user can read every envelope in the account, so reads need no per-user login.
// An envelope is created as a draft ("created") unless the caller asks to send it.
//
// Source of each function, from the CAO CRM at commit 28aa5d91 unless marked NEW:
//   accessToken        lib/docusign.ts buildJwt and getDocuSignToken (JWT grant, "signature impersonation")
//   listEnvelopes      lib/docusign.ts listEnvelopes (100 a page, start_position)
//   getEnvelope        lib/docusign.ts getEnvelope (with the recipients and custom-field fallbacks)
//   downloadSigned     lib/docusign.ts downloadSignedPdf (combined, with the certificate)
//   createFromTemplate NEW: a plain template-roles envelope from DocuSign's docs, defaulting to a draft.
//                      The CRM's send-sa route builds a composite envelope from its own stamped document
//                      with tabs copied off the template; that is CAO's agreement layout, so it stays out.
//   baseUri            NEW: reads the account's API host from DocuSign's userinfo instead of the CRM's fixed
//                      AU host, so the same code works for any region and for the sandbox. Not yet run in production.
// CAO's signatory map, rep names and the crm_lead_id field name are now parameters.

import { call, type AppSpec } from "../../lib/http.ts";
import { optional, secret } from "../../lib/secrets.ts";
import { pem, signJwt } from "../../lib/jwt.ts";
import { collect } from "../../lib/paging.ts";

const demo = () => optional("DOCUSIGN_ENV") === "demo";
const authHost = () => (demo() ? "account-d.docusign.com" : "account.docusign.com");

export const spec: AppSpec = {
  app: "docusign",
  hosts: ["account.docusign.com", "account-d.docusign.com", "demo.docusign.net"],
  hostPattern: /^[a-z0-9-]+\.docusign\.net$/,
  readPosts: ["account.docusign.com/oauth/token", "account-d.docusign.com/oauth/token"],
};

let cached: { token: string; until: number; base: string } | null = null;

async function login(): Promise<{ token: string; base: string }> {
  if (cached && cached.until > Date.now() + 60_000) return cached;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: secret("DOCUSIGN_INTEGRATION_KEY"), sub: secret("DOCUSIGN_USER_ID"), aud: authHost(), iat: now, exp: now + 3600, scope: "signature impersonation" }, pem(secret("DOCUSIGN_PRIVATE_KEY")));
  const t = await call<any>(spec, { method: "POST", url: `https://${authHost()}/oauth/token`, form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }, retries: 1 });
  const token = t.data?.access_token;
  if (!token) throw new Error("DocuSign login failed. The user must grant consent to the integration key once.");
  const info = await call<any>(spec, { url: `https://${authHost()}/oauth/userinfo`, headers: { Authorization: `Bearer ${token}` } });
  const acct = (info.data?.accounts ?? []).find((a: any) => a.account_id === secret("DOCUSIGN_ACCOUNT_ID"));
  if (!acct?.base_uri) throw new Error("DocuSign account not found for this user");
  cached = { token, base: `${acct.base_uri}/restapi/v2.1/accounts/${secret("DOCUSIGN_ACCOUNT_ID")}`, until: Date.now() + (t.data.expires_in ?? 3600) * 1000 };
  return cached;
}
export function clearTokenCache(): void { cached = null; }

/** The signed-in token and account base URL, for the agent SDK (core/sdk/call.ts). */
export async function session(): Promise<{ token: string; base: string }> { return login(); }

export interface Recipient { name: string; email: string; status: string; signedDateTime: string | null; routingOrder: string | null }
export interface Envelope { envelopeId: string; status: string; emailSubject?: string; sentDateTime?: string; completedDateTime?: string; senderEmail?: string; signerEmails: string[]; recipients: Recipient[]; customFields: Record<string, string>; raw: unknown }

function shape(e: any, signers?: any[], custom?: any): Envelope {
  const fields: Record<string, string> = {};
  for (const f of (custom ?? e.customFields)?.textCustomFields ?? []) if (f?.name) fields[f.name] = f.value ?? "";
  const list: any[] = signers ?? e.recipients?.signers ?? [];
  return {
    envelopeId: e.envelopeId, status: e.status, emailSubject: e.emailSubject, sentDateTime: e.sentDateTime, completedDateTime: e.completedDateTime,
    senderEmail: e.sender?.email, signerEmails: list.map((s: any) => String(s.email || "").toLowerCase()).filter(Boolean),
    recipients: list.map((s: any) => ({ name: s.name ?? "", email: String(s.email || "").toLowerCase(), status: s.status ?? "", signedDateTime: s.signedDateTime ?? null, routingOrder: s.routingOrder ?? null })),
    // The whole envelope as DocuSign sent it, as the CRM's list returns it.
    customFields: fields, raw: e,
  };
}

/** Every envelope since a date (YYYY-MM-DD). Status filter is optional: sent, delivered, completed, declined, voided. */
export async function listEnvelopes(fromDate: string, status?: string): Promise<Envelope[]> {
  const { token, base } = await login();
  return collect<Envelope, number>(0, async (start) => {
    const r = await call<any>(spec, { url: `${base}/envelopes`, headers: { Authorization: `Bearer ${token}` }, query: { from_date: fromDate, count: 100, start_position: start, include: "recipients,custom_fields", status } });
    const page = r.data?.envelopes ?? [];
    return { items: page.map((e: any) => shape(e)), next: page.length < 100 ? null : start + 100 };
  }, { maxPages: 200 });
}

export async function getEnvelope(id: string): Promise<Envelope | null> {
  const { token, base } = await login();
  const H = { Authorization: `Bearer ${token}` };
  let e: any;
  try { e = (await call<any>(spec, { url: `${base}/envelopes/${encodeURIComponent(id)}`, headers: H, query: { include: "recipients,custom_fields" } })).data; }
  catch (err: any) { if (err?.status === 404) return null; throw err; }
  // The include is not always honoured, so fall back to the dedicated endpoints.
  const signers = e.recipients?.signers ?? (await call<any>(spec, { url: `${base}/envelopes/${encodeURIComponent(id)}/recipients`, headers: H })).data?.signers;
  const custom = e.customFields ?? (await call<any>(spec, { url: `${base}/envelopes/${encodeURIComponent(id)}/custom_fields`, headers: H })).data;
  return shape(e, signers, custom);
}

/** The signed document with its certificate, as PDF bytes. */
export async function downloadSigned(id: string): Promise<Buffer> {
  const { token, base } = await login();
  const r = await call<ArrayBuffer>(spec, { url: `${base}/envelopes/${encodeURIComponent(id)}/documents/combined`, headers: { Authorization: `Bearer ${token}` }, query: { certificate: true }, binary: true, followDownloadRedirects: true });
  return Buffer.from(r.data);
}

/**
 * Creates an envelope from a template. Needs KIT_ALLOW_WRITES=1. Saved as a draft unless send is true.
 * customFields carry the record the envelope belongs to (the CRM uses one named crm_lead_id).
 */
export async function createFromTemplate(o: { templateId: string; roles: { roleName: string; name: string; email: string; tabs?: Record<string, unknown> }[]; emailSubject?: string; customFields?: Record<string, string>; send?: boolean }): Promise<string> {
  const { token, base } = await login();
  const r = await call<any>(spec, {
    method: "POST", url: `${base}/envelopes`, headers: { Authorization: `Bearer ${token}` },
    json: {
      templateId: o.templateId, templateRoles: o.roles, emailSubject: o.emailSubject, status: o.send ? "sent" : "created",
      customFields: o.customFields ? { textCustomFields: Object.entries(o.customFields).map(([name, value]) => ({ name, value, show: "false" })) } : undefined,
    },
  });
  return r.data?.envelopeId;
}

/** The kit's document record. */
export const toDocument = (e: Envelope) => ({ id: e.envelopeId, title: e.emailSubject ?? "", kind: "agreement", status: e.status, signed_at: e.completedDateTime ?? null });
