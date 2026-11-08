"use server";
// The approval click. A workflow's cron queues anything that reaches a customer, moves money or changes a live record;
// it runs only when a person approves it here. Staff only (admin or member; viewers cannot approve). The approval is
// looked up in the store and its workflow must be switched on; the act itself runs in the workflow runtime.
import { revalidatePath } from "next/cache";
import { prismadb } from "@/lib/prisma";
import { assertActionSession } from "@/lib/auth-server";
import { writeAuditLog } from "@/lib/audit-log";
import { runDecision } from "@/lib/shell/runner";

export async function decide(approvalId: string, decision: "approve" | "reject", confirm?: "done" | "retry"): Promise<{ ok: boolean; message: string }> {
  try {
    const session = await assertActionSession();
    const row = await prismadb.shell_State.findUnique({ where: { ns_key: { ns: "approvals", key: approvalId } } });
    const ap = row?.value as { workflow?: string; status?: string } | undefined;
    if (!ap?.workflow) throw new Error("No such approval");
    const wf = await prismadb.shell_Workflows.findUnique({ where: { id: ap.workflow } });
    if (!wf?.enabled) throw new Error("That workflow is switched off");
    const who = session.user.email ?? session.user.id;
    const r = await runDecision(wf.dir, decision, approvalId, who, confirm);
    await writeAuditLog({ entityType: "approval", entityId: approvalId, action: decision === "approve" ? "approved" : "rejected", changes: [{ field: "result", old: ap.status ?? null, new: r.ok ? "ok" : "failed" }], userId: session.user.id });
    revalidatePath("/[locale]/(routes)/approvals", "page");
    return { ok: r.ok, message: r.ok ? (decision === "approve" ? "Approved and run." : "Rejected.") : r.out.split("\n")[0].slice(0, 200) };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "Could not decide" }; }
}
