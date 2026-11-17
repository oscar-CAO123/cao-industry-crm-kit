// The approval click's signature. The runner hands it to the workflow runtime's approve command, which accepts a
// CRM-made approval only with this ticket (core/workflows/approval-proof.ts verifies it; the two must stay in step,
// and tests/write-gate-approvals.test.ts checks they do). Signed with a key derived from BETTER_AUTH_SECRET, valid for two
// minutes, bound to the approval id, the decision, who clicked and any done|retry answer. No imports beyond node.
import crypto from "node:crypto";

export function approvalTicket(id: string, who: string, confirm?: "done" | "retry", now = Date.now()): string {
  const s = process.env.BETTER_AUTH_SECRET ?? "";
  if (s.length < 32) throw new Error("BETTER_AUTH_SECRET is missing or too short: approvals cannot be signed");
  const key = crypto.createHmac("sha256", s).update("kit-approval-ticket-v1").digest();
  const exp = now + 2 * 60_000;
  const mac = crypto.createHmac("sha256", key).update(JSON.stringify([id, "approve", who, confirm ?? "", exp])).digest("base64url");
  return `${exp}.${mac}`;
}
