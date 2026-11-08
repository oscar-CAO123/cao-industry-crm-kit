// Runs one approval decision through the workflow runtime, in its own process (shell/workflows/run.ts), so the
// web server never imports the SDK and a crash in a vendor call cannot take the CRM down. The approval, its lock and
// its result all live in the shared store, so the shell and the crons always agree on what happened.
import { execFile } from "node:child_process";
import path from "node:path";
import { kitRoot } from "./kit";

const DIR = /^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/;
const ID = /^[a-z0-9:._-]{1,120}$/i;

export function runDecision(dir: string, cmd: "approve" | "reject", approvalId: string, who: string, confirm?: "done" | "retry"): Promise<{ ok: boolean; out: string }> {
  if (!DIR.test(dir) || !ID.test(approvalId)) return Promise.resolve({ ok: false, out: "bad approval" });
  const root = kitRoot();
  const args = [path.join(root, "shell/workflows/run.ts"), cmd, dir, approvalId, who.replace(/[^\w@.+-]/g, "").slice(0, 120) || "unknown", ...(confirm ? [confirm] : [])];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: root, env: process.env, timeout: 5 * 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (err ? stderr || String(err.message) : stdout).slice(0, 2000) });
    });
  });
}
