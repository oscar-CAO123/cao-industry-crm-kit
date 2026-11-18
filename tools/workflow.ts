// Run a workflow's crons and approvals from the command line. This is the one entry point every deploy target calls.
//   node tools/workflow.ts run       <workflow-dir> <cron>
//   node tools/workflow.ts approvals <workflow-dir>                 pending approvals, newest first
//   node tools/workflow.ts approve   <workflow-dir> <id> <who> [done|retry]   runs it (needs KIT_ALLOW_WRITES=1); done|retry only
//                                                                              after checking the platform on a needs-check approval.
//                                                                              A person must stand behind it: the CRM's signed click,
//                                                                              or a person typing approve at the terminal (core/workflows/approval-proof.ts).
//   node tools/workflow.ts reject    <workflow-dir> <id> <who>
//   node tools/workflow.ts propose   <workflow-dir> <enquiry-id> <lines.json>
// Settings come from KIT_SETTINGS (a file path) or KIT_SETTINGS_JSON. State lives in KIT_STATE_DIR (default ./state).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context, approve, reject, redactForPrint, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { FileStore, type Store } from "../core/workflows/store.ts";
import { requirePerson, approvalDigest, printable } from "../core/workflows/approval-proof.ts";
import { describe } from "../core/sdk/call.ts";
import { grantWrites, revokeWrites } from "../core/lib/http.ts";

/** An operation's exact id, which is what a scoped grant compares; an id the SDK does not map grants nothing. */
const exactOps = (list: { platform: string; op: string }[]) => list.flatMap(({ platform, op }) => { try { return [{ platform, op: describe(platform, op).id }]; } catch { return []; } });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_DIR = /^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/;

export async function load(dir: string) {
  const rel = path.relative(ROOT, path.resolve(ROOT, dir)).split(path.sep).join("/");
  if (!SAFE_DIR.test(rel)) throw new Error(`not a workflow folder: ${dir}`);
  const abs = path.join(ROOT, rel);
  const record = JSON.parse(fs.readFileSync(path.join(abs, "workflow.json"), "utf8")) as WorkflowRecord;
  const mod = await import(path.join(abs, "index.ts"));
  return { record, crons: mod.CRONS as Record<string, (ctx: any) => Promise<unknown>> };
}

export function settings(): unknown {
  if (process.env.KIT_SETTINGS_JSON) return JSON.parse(process.env.KIT_SETTINGS_JSON);
  if (process.env.KIT_SETTINGS) return JSON.parse(fs.readFileSync(process.env.KIT_SETTINGS, "utf8"));
  throw new Error("set KIT_SETTINGS (file) or KIT_SETTINGS_JSON");
}

export async function main(argv: string[], store: Store = new FileStore(), ask?: (q: string) => string | null) {
  const [cmd, dir, a, b] = argv;
  const { record, crons } = await load(dir ?? "");
  if (cmd === "run") {
    if (!record.crons.some((c) => c.entry === a) || !crons[a]) throw new Error(`no cron ${a} in ${record.id}`);
    // A cron may write only its own draft operations; the grant names them, so no other operation opens.
    grantWrites(`cron ${record.id} ${a}`, exactOps(Object.entries(record.draft_ops).flatMap(([platform, ops]) => ops.map((op) => ({ platform, op })))));
    return crons[a](context(record, settings(), store));
  }
  if (cmd === "approvals") {
    const all = Object.values(await store.list<Approval>("approvals")).filter((x) => x.workflow === record.id && ["pending", "running", "failed", "needs-check"].includes(x.status));
    return all.sort((x, y) => y.created.localeCompare(x.created)).map((x) => ({ id: x.id, status: x.status, summary: x.summary, created: x.created, ...(x.error ? { error: x.error } : {}) }));
  }
  if (cmd === "approve") {
    const who = b ?? "unknown";
    const confirm = (["done", "retry"].includes(argv[4]) ? argv[4] : undefined) as "done" | "retry" | undefined;
    const ap = await store.get<Approval>("approvals", a ?? "");
    if (!ap) throw new Error(`no approval ${a}`);
    // What the person approves is exactly these acts: the ticket or the terminal answer is bound to their digest, and
    // approve() checks the digest again under its lock, so an act changed in the store after this cannot run.
    const digest = approvalDigest(ap);
    // Every act whole (inputs, its check and key included), never cut: a part the person cannot see is never approved
    // (too long for a terminal: the CRM shows it all).
    const shown = [printable(ap.summary), ...ap.acts.flatMap((x, i) => [printable(`${i + 1}. ${x.platform} ${x.op}`), ...JSON.stringify(x, null, 1).split("\n")])].join("\n");
    const how = requirePerson({ id: a ?? "", decision: "approve", who, confirm, acts: digest }, shown, ask);
    grantWrites(`approval ${a} (${how})`, exactOps(ap.acts.map((x) => ({ platform: x.platform, op: x.op }))));
    try { return await approve(record, store, a, who, new Date(), confirm, digest); } finally { revokeWrites(); }
  }
  // Under the approve lock, so a reject cannot overwrite an approval someone has just started running.
  if (cmd === "reject") return store.locked("approve-claims", () => reject(record, store, a, b ?? "unknown"));
  if (cmd === "propose") {
    if (!(await store.get("enquiries", a))) throw new Error(`no enquiry ${a}`);
    const lines = JSON.parse(fs.readFileSync(b, "utf8"));
    if (!Array.isArray(lines) || !lines.length || lines.length > 200 || !lines.every((l) => typeof l?.code === "string" && Number(l.qty) > 0))
      throw new Error("lines.json must be [{code, qty, unitPrice?}]");
    await store.put("proposals", a, { lines: lines.map((l) => ({ code: l.code, qty: Number(l.qty), ...(typeof l.unitPrice === "number" ? { unitPrice: l.unitPrice } : {}) })), at: new Date().toISOString() });
    return { proposed: a };
  }
  throw new Error("usage: run|approvals|approve|reject|propose <workflow-dir> ...");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((r) => {
    console.log(JSON.stringify(redactForPrint(r ?? null), null, 1));
    const ap = r as { status?: string; error?: string } | null; // a refused or failed act is recorded, not thrown
    if (process.argv[2] === "approve" && ap?.status && ap.status !== "done") { console.error(`${ap.status}: ${String(ap.error ?? "").slice(0, 280)}`); process.exit(1); }
  }, (e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
