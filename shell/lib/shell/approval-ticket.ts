// The approval click's signature. The runner hands it to the workflow runtime's approve command, which accepts a
// CRM-made approval only with this ticket (core/workflows/approval-proof.ts verifies it; the two must stay in step,
// and tests/write-gate-approvals.test.ts checks they do). Signed with a key derived from BETTER_AUTH_SECRET, valid for two
// minutes, bound to the approval id, the decision, who clicked, any done|retry answer and the digest of the exact acts the
// person was shown. No imports beyond node.
import crypto from "node:crypto";

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
/** The digest of what a person approves, the same as core/workflows/approval-proof.ts actsDigest and approvalDigest. */
export function actsDigest(v: unknown): string {
  return crypto.createHash("sha256").update(canonical(JSON.parse(JSON.stringify(v ?? null)))).digest("base64url");
}
export const approvalDigest = (ap: { summary?: unknown; acts?: unknown }) => actsDigest({ summary: ap.summary ?? "", acts: ap.acts ?? [] });

export function approvalTicket(id: string, who: string, acts: string, confirm?: "done" | "retry", now = Date.now()): string {
  const s = process.env.BETTER_AUTH_SECRET ?? "";
  if (s.length < 32) throw new Error("BETTER_AUTH_SECRET is missing or too short: approvals cannot be signed");
  const key = crypto.createHmac("sha256", s).update("kit-approval-ticket-v1").digest();
  const exp = now + 2 * 60_000;
  const mac = crypto.createHmac("sha256", key).update(JSON.stringify([id, "approve", who, confirm ?? "", acts, exp])).digest("base64url");
  return `${exp}.${mac}`;
}
