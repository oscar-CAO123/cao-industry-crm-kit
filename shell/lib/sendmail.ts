// A notice to one of the CRM's own users (a record assigned to you, your account approved). It goes through
// lib/mail.ts, which refuses anyone who is not a user of this CRM. SMTP comes from the secret store as SMTP_URL.
import mailer from "@/lib/mail";

interface EmailOptions { from?: string; to: string; subject: string; text: string; html?: string }

export default async function sendEmail(o: EmailOptions): Promise<void> {
  try {
    const mail = await mailer();
    await mail.emails.send({ from: o.from, to: o.to, subject: o.subject, text: o.text, html: o.html });
  } catch (e) {
    console.error("[mail] notice not sent:", e instanceof Error ? e.message : "error");
  }
}
