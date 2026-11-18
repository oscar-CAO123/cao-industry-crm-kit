#!/usr/bin/env node
// The agent SDK from the command line. Output is JSON so an agent can read it.
//   node tools/sdk.mjs platforms
//   node tools/sdk.mjs search <platform> <words...>
//   node tools/sdk.mjs describe <platform> <operationId>
//   node tools/sdk.mjs plan <platform> <operationId> [--params '{"id":"1"}'] [--body '{...}'] [--select 'id name']
//   node tools/sdk.mjs call <platform> <operationId> --live [same options]
// plan shows the request with keys hidden and sends nothing. call needs --live, the platform's keys in the
// environment (from the client's secret store), and KIT_ALLOW_WRITES=1 for anything that is not a read. A write also
// asks the person at the terminal (/dev/tty, never stdin) to type yes; an agent never answers that prompt.
import { listPlatforms, load, search, describe, plan, callOperation } from "../core/sdk/call.ts";
import { grantWrites } from "../core/lib/http.ts";
import { askTerminal, accountPassword, showInFull, printable } from "../core/workflows/approval-proof.ts";

const [cmd, id, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const json = (name) => { const v = opt(name); if (v === undefined) return undefined; try { return JSON.parse(v); } catch { fail(`--${name} must be JSON`); } };
const out = (v) => process.stdout.write(JSON.stringify(v, null, 1) + "\n");
function fail(msg) { process.stderr.write(msg + "\n"); process.exit(1); }
const input = () => ({ params: json("params"), body: json("body"), select: opt("select"), document: opt("document"), as: opt("as") });

try {
  if (cmd === "platforms") out(listPlatforms().map((p) => { const { platform: x } = load(p); return { id: x.id, name: x.name, endpoints: x.counts.operations, source: x.status, signIn: x.authProof, keys: x.keys }; }));
  else if (cmd === "search") out(search(id, rest.filter((r) => !r.startsWith("--")).join(" "), Number(opt("limit") ?? 15)).map((o) => ({ id: o.id, method: o.method, path: o.path, kind: o.kind, summary: o.summary, required: o.params.filter((p) => p.required).map((p) => p.name) })));
  else if (cmd === "describe") out(describe(id, rest[0]));
  else if (cmd === "plan") out(await plan(id, rest[0], input()));
  else if (cmd === "call") {
    if (!rest.includes("--live")) fail("call sends a real request: add --live (use plan to preview)");
    const op = describe(id, rest[0]);
    if (op.kind !== "read" && process.env.KIT_ALLOW_WRITES === "1") {
      const p = await plan(id, rest[0], input());
      // The whole request, escaped, or nothing: a part cut off would be sent unseen (too long: send it through a CRM approval).
      let shown;
      try { shown = showInFull([printable(`${id} ${op.method} ${op.path} is a write: ${op.summary ?? ""}`), ...JSON.stringify(p, null, 1).split("\n")].join("\n")); } catch (e) { fail(e.message); }
      const answer = askTerminal(`${shown}\nType yes to send it now: `);
      if (answer === null) fail("a write needs a person: run this command yourself in a terminal (it asks there, not on stdin)");
      if (answer !== "yes") fail("not confirmed: nothing was sent");
      // An agent that opens its own terminal could type yes; it does not know the account password.
      if (!accountPassword("Your computer password, to confirm it is you: ")) fail("not confirmed: the account password was not given (where sudo needs no password, writes go through a CRM approval)");
      grantWrites(`sdk call ${id} ${rest[0]} (terminal)`, [{ platform: id, op: op.id }]);
    }
    const r = await callOperation(id, rest[0], input());
    out({ status: r.status, data: r.data });
  } else fail("usage: platforms | search <platform> <words> | describe <platform> <op> | plan <platform> <op> [--params JSON] | call <platform> <op> --live");
} catch (e) {
  fail(`${e.name ?? "Error"}: ${e.message}`);
}
