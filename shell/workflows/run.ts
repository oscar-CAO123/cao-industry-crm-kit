// The one entry point for a workflow's crons and approvals when the CRM shell is deployed: tools/workflow.ts with
// the shell's database store in place of the file store. Every deploy target runs this command.
//   node shell/workflows/run.ts run       <workflow-dir> <cron>
//   node shell/workflows/run.ts approvals <workflow-dir>
//   node shell/workflows/run.ts approve   <workflow-dir> <approval-id> <who> [done|retry]
//   node shell/workflows/run.ts reject    <workflow-dir> <approval-id> <who>
// It refuses any workflow that is not switched on in this CRM (shell_Workflows.enabled).
// Keys arrive in the environment from the secret layer (shell/scripts/with-secrets.sh); writes still need
// KIT_ALLOW_WRITES=1, and the workflow runtime lets a cron run only its draft operations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { main } from "../../tools/workflow.ts";
import { PgStore } from "./pg-store.ts";
import { pgPoolConfig } from "../lib/db-ssl.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = /^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/;

export async function run(argv: string[]): Promise<unknown> {
  const [cmd, dir] = argv;
  if (!["run", "approvals", "approve", "reject"].includes(cmd) || !DIR.test(dir ?? "")) throw new Error("usage: run|approvals|approve|reject <workflow-dir> ...");
  const id = String(JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workflow.json"), "utf8")).id);
  // a workflow's settings file is shell/settings/<id>.json unless the deploy names another
  if (!process.env.KIT_SETTINGS && !process.env.KIT_SETTINGS_JSON) process.env.KIT_SETTINGS = path.join(ROOT, "shell/settings", `${id.replace(/[^a-z0-9-]/gi, "-")}.json`);
  const pool = new pg.Pool({ ...pgPoolConfig(process.env.DATABASE_URL ?? ""), max: 3 });
  try {
    const on = await pool.query('SELECT enabled FROM "shell_Workflows" WHERE id = $1 AND dir = $2', [id, dir]);
    if (!on.rows[0]?.enabled) throw new Error(`${id} is not switched on in this CRM`);
    return await main(argv, new PgStore(id, pool));
  } finally { await pool.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).then((r) => console.log(JSON.stringify(r ?? null)), (e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
}
