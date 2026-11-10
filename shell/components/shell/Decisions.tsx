"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { decide } from "@/actions/shell/approvals";
import { applyTemplate, undoTemplate } from "@/actions/shell/templates";

/** Approve or reject one queued act. A needs-check item is confirmed as done (it already happened) or retried. */
export function ApprovalButtons({ id, status }: { id: string; status: string }) {
  const [busy, start] = useTransition();
  const router = useRouter();
  const go = (d: "approve" | "reject", c?: "done" | "retry") => start(async () => { const r = await decide(id, d, c); (r.ok ? toast.success : toast.error)(r.message); router.refresh(); });
  if (status === "needs-check") return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => go("approve", "done")}>It happened: mark done</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm("Run it again? Check the app first: this can repeat a send.") && go("approve", "retry")}>Run again</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => go("reject")}>Reject</Button>
    </div>
  );
  return (
    <div className="flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => go("approve")}>{status === "failed" ? "Retry" : "Approve"}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => go("reject")}>Reject</Button>
    </div>
  );
}

/** The template buttons: apply (after the preview above it) and undo. */
export function TemplateButtons({ industry, name, appliedId, adds }: { industry: string; name: string; appliedId: string | null; adds: number }) {
  const [busy, start] = useTransition();
  const router = useRouter();
  const done = (r: { ok: boolean; message: string }) => { (r.ok ? toast.success : toast.error)(r.message); router.refresh(); };
  return (
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || adds === 0} onClick={() => confirm(`Apply the ${name} template? It adds the ${adds} pages and workflows listed below.`) && start(async () => done(await applyTemplate(industry)))}>
        {adds === 0 ? "Everything is already on" : `Apply the ${name} template`}
      </Button>
      {appliedId && (
        <Button variant="outline" disabled={busy} onClick={() => confirm("Undo this template? Its pages and workflows are removed; records stay.") && start(async () => done(await undoTemplate(appliedId)))}>Undo</Button>
      )}
    </div>
  );
}
