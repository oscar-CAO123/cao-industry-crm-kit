// The HTTP runner: for schedulers that can only call a URL (Vercel Cron, Supabase pg_cron, Cloudflare Cron Triggers).
// It runs where the workflow state lives (a container with a volume) and accepts exactly one request shape:
//   POST /run/<cron>   Authorization: Bearer $KIT_RUNNER_TOKEN
// Nothing else is served. Approvals never go through here: they come from the CRM shell.
import http from "node:http";
import crypto from "node:crypto";
import { main } from "./workflow.ts";

const DIR = process.env.KIT_WORKFLOW ?? "";
const TOKEN = process.env.KIT_RUNNER_TOKEN ?? "";

export function handler(run: (cron: string) => Promise<unknown> = (c) => main(["run", DIR, c])) {
  let busy = false;
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const m = /^\/run\/([a-z0-9-]{1,40})$/.exec(req.url ?? "");
    const auth = String(req.headers.authorization ?? "");
    const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();
    const ok = TOKEN.length >= 32 && crypto.timingSafeEqual(digest(auth), digest(`Bearer ${TOKEN}`));
    if (req.method !== "POST" || !m) { res.writeHead(404).end(); return; }
    if (!ok) { res.writeHead(401).end(); return; }
    if (busy) { res.writeHead(409).end(); return; } // one run at a time: a slow run is never doubled by the next tick
    busy = true;
    try { const r = await run(m[1]); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r ?? null)); }
    catch { res.writeHead(500).end(); }
    finally { busy = false; }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!DIR || TOKEN.length < 32) { console.error("set KIT_WORKFLOW and a KIT_RUNNER_TOKEN of 32+ characters"); process.exit(1); }
  http.createServer(handler()).listen(Number(process.env.PORT ?? 8080));
}
