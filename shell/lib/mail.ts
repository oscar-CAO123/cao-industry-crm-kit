// Internal mail: sign-in codes and notices to the business's own users (an invite, a task assigned to you).
//
// Rules, enforced here:
// - Mail reaches only people who already have a user row in this CRM, except a sign-in code, which goes to the
//   address that asked for it. Anything to a customer, supplier or anyone outside the business is a live action:
//   it goes through a workflow's approval queue (core/workflows/runtime.ts), never through this module.
// - Plain SMTP, so it works with any provider. SMTP_URL (smtp://user:pass@host:587) comes from the secret store
//   at process start (shell/scripts/with-secrets.sh); it is never written to a file or a log.
// - With no SMTP_URL, mailer() throws MailNotConfigured, so no caller can report a message as sent when it was not.
//   Call sites that treat mail as optional (task notices) already skip it; an invite or a sign-in code fails visibly.
//   Nothing about the message is logged: a subject can carry a sign-in code.
import nodemailer, { type Transporter } from "nodemailer";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { prismadb } from "@/lib/prisma";

export interface MailMessage {
  from?: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  react?: ReactElement;
}

export class MailRefused extends Error {}
export class MailNotConfigured extends Error {
  constructor() { super("Mail is not set up for this CRM (SMTP_URL): nothing was sent"); this.name = "MailNotConfigured"; }
}

let transport: Transporter | null | undefined;
function smtp(): Transporter | null {
  if (transport === undefined) transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
  return transport;
}

async function internalOnly(to: string[]): Promise<void> {
  const known = await prismadb.users.findMany({ where: { email: { in: to.map((t) => t.toLowerCase()) } }, select: { email: true } });
  const ok = new Set(known.map((u) => u.email.toLowerCase()));
  const outside = to.filter((t) => !ok.has(t.toLowerCase()));
  if (outside.length) throw new MailRefused(`internal mail refused for ${outside.length} address(es) outside this CRM`);
}

async function send(m: MailMessage, signIn: boolean): Promise<void> {
  const to = (Array.isArray(m.to) ? m.to : [m.to]).map((t) => t.trim()).filter(Boolean);
  if (!to.length) return;
  if (signIn ? to.length !== 1 : false) throw new MailRefused("a sign-in code goes to one address");
  if (!signIn) await internalOnly(to);
  const html = m.html ?? (m.react ? await render(m.react) : undefined);
  const t = smtp();
  if (!t) throw new MailNotConfigured();
  await t.sendMail({ from: m.from ?? process.env.EMAIL_FROM, to, subject: m.subject, text: m.text, html });
}

/** The mailer, in the shape the CRM's call sites use: `const mail = await mailer(); await mail.emails.send({...})`. */
export default async function mailer(opts: { signIn?: boolean } = {}) {
  if (!smtp()) throw new MailNotConfigured();
  return { emails: { send: (m: MailMessage) => send(m, !!opts.signIn) } };
}
