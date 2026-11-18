// Runs one approval decision through the workflow runtime, in its own process (shell/workflows/run.ts), so the
// web server never imports the SDK and a crash in a vendor call cannot take the CRM down. The approval, its lock and
// its result all live in the shared store, so the shell and the crons always agree on what happened.
import { execFile } from "node:child_process";
import path from "node:path";
import { kitRoot } from "./kit";
import { approvalTicket } from "./approval-ticket";

const DIR = /^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/;
const ID = /^[a-z0-9:._-]{1,120}$/i;

export function runDecision(dir: string, cmd: "approve" | "reject", approvalId: string, who: string, confirm?: "done" | "retry", acts = ""): Promise<{ ok: boolean; out: string }> {
  if (!DIR.test(dir) || !ID.test(approvalId)) return Promise.resolve({ ok: false, out: "bad approval" });
  const root = kitRoot();
  const by = who.replace(/[^\w@.+-]/g, "").slice(0, 120) || "unknown";
  const args = [path.join(root, "shell/workflows/run.ts"), cmd, dir, approvalId, by, ...(confirm ? [confirm] : [])];
  // The runtime runs a CRM approval only with the click's signed ticket (core/workflows/approval-proof.ts), bound to the
  // digest of the acts the person was shown.
  let env: NodeJS.ProcessEnv = process.env;
  if (cmd === "approve") {
    try { env = { ...process.env, KIT_APPROVAL_TICKET: approvalTicket(approvalId, by, acts, confirm) }; }
    catch (e) { return Promise.resolve({ ok: false, out: e instanceof Error ? e.message : "cannot sign the approval" }); }
  }
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: root, env, timeout: 5 * 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (err ? stderr || String(err.message) : stdout).slice(0, 2000) });
    });
  });
}
