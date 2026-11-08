// The trigger URL for hosts whose schedulers can only call a URL (Vercel Cron, Supabase pg_cron, Cloudflare Cron
// Triggers, Netlify scheduled functions). Exactly one request shape:
//   POST /api/workflows/run   Authorization: Bearer $KIT_RUNNER_TOKEN   {"workflow": "<id>", "cron": "<entry>"}
//   GET  /api/workflows/run?workflow=<id>&cron=<entry>   same header (Vercel Cron sends GET with CRON_SECRET)
// The workflow must be switched on in this CRM and the cron must be one its record declares. The run itself is the
// same command every container target uses (shell/workflows/run.ts), so a cron can still only draft: anything live
// is queued for the approval click. Approvals never come through here.
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { prismadb } from "@/lib/prisma";
import { kitRoot, workflowInfo } from "@/lib/shell/kit";

const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
let busy = false;

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return run(req, { workflow: q.get("workflow") ?? "", cron: q.get("cron") ?? "" });
}

export async function POST(req: NextRequest) {
  return run(req, await req.json().catch(() => null));
}

async function run(req: NextRequest, body: { workflow?: unknown; cron?: unknown } | null) {
  const token = process.env.KIT_RUNNER_TOKEN || process.env.CRON_SECRET || "";
  const ok = token.length >= 32 && crypto.timingSafeEqual(digest(req.headers.get("authorization") ?? ""), digest(`Bearer ${token}`));
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = typeof body?.workflow === "string" ? body.workflow : "";
  const cron = typeof body?.cron === "string" ? body.cron : "";
  if (!/^[a-z0-9:-]{1,80}$/.test(id) || !/^[a-z0-9-]{1,40}$/.test(cron)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const wf = await prismadb.shell_Workflows.findUnique({ where: { id } });
  if (!wf?.enabled) return NextResponse.json({ error: "Not switched on" }, { status: 404 });
  if (!workflowInfo(wf.dir).crons.some((c) => c.entry === cron)) return NextResponse.json({ error: "No such cron" }, { status: 404 });
  if (busy) return NextResponse.json({ error: "Busy" }, { status: 409 }); // one run at a time per instance
  busy = true;
  try {
    const root = kitRoot();
    const r = await new Promise<{ ok: boolean }>((resolve) =>
      execFile(process.execPath, [path.join(root, "shell/workflows/run.ts"), "run", wf.dir, cron], { cwd: root, env: process.env, timeout: 10 * 60_000, maxBuffer: 1 << 20 }, (err) => resolve({ ok: !err })));
    return NextResponse.json({ ran: r.ok }, { status: r.ok ? 200 : 500 });
  } finally { busy = false; }
}
