// Opportunity-finding workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { scan, logOpportunities, digest, CRONS } from "../industries/all/workflows/sales/opportunity-finding/index.ts";
import type { Opportunity, Verdict } from "../industries/all/workflows/sales/opportunity-finding/types.ts";

const DIR = "industries/all/workflows/sales/opportunity-finding";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  business_name: "Test Civil",
  microsoft_365: { mailbox: "tenders@example.com.au", folder: "inbox", search: "tender",
    register: { drive: "b!drive1", item: "01ITEM2", table: "Opportunities" } },
  digest_to: "owner@example.com.au",
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
const SUBJECTS = ["<img src=x onerror=alert(1)> Fencing tender", "=cmd|' /C calc'!A0 civil works panel"];
const IDS = ["AAMkAlert1", "AAMkAlert2"];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: "AAMkDraft1" });
      if (p.endsWith("/messages")) return json({ value: IDS.map((id, i) => ({ id, subject: SUBJECTS[i],
        from: { emailAddress: { name: "Council", address: "tenders@council.example" } }, receivedDateTime: "2026-11-08T00:00:00Z",
        bodyPreview: "Closes 30 November. Submissions by the portal." })) });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("every operation the workflow names is mapped in the kit", () => {
  for (const [p, ops] of Object.entries(WF.draft_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(p, op), `${p} ${op}`);
  for (const [p, ops] of Object.entries(WF.live_ops)) for (const op of ops) assert.doesNotThrow(() => describeOp(p, op), `${p} ${op}`);
});

test("the crons in workflow.json and the exported crons match", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a cron cannot run a live operation, and cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x", input: {} }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.mailFolders.ListMessages", summary: "x", input: {} }), /not a live operation/);
});

test("a bad mailbox is refused before any network call", async () => {
  const bad = { ...S, microsoft_365: { ...S.microsoft_365, mailbox: "not-an-address" } };
  await assert.rejects(scan(context(WF, bad, new MemoryStore(), NOW, () => {})), /mailbox/);
  assert.equal(hits.length, 0);
});

test("scan stores each alert once and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await scan(ctx), { added: 2 });
  assert.deepEqual(await scan(ctx), { added: 0 });
  assert.equal(sends().length, 0);
  const opps = await store.list<Opportunity>("opportunities");
  assert.equal(Object.values(opps).every((o) => o.status === "new"), true);
});

test("log writes one register write per run, escapes text, and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await scan(ctx);
  assert.deepEqual(await logOpportunities(ctx), { logged: 2 });
  assert.equal(hits.filter((h) => h.path.endsWith("/rows")).length, 1);
  const rows: unknown[][] = hits.find((h) => h.path.endsWith("/rows"))!.body.values;
  assert.ok(rows.flat().includes("'=cmd|' /C calc'!A0 civil works panel"), "formula cell is prefixed");
  assert.deepEqual(await logOpportunities(ctx), { logged: 0 });
  assert.equal(sends().length, 0);
});

test("digest drafts one email, queues its send, dismisses the no's, and never repeats the same day", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await scan(ctx); await logOpportunities(ctx);
  const opps = await store.list<Opportunity>("opportunities");
  const byMsg = (id: string) => Object.values(opps).find((o) => o.ref.message_id === id)!;
  const fits = byMsg("AAMkAlert1"), no = byMsg("AAMkAlert2");
  await store.put("fit", fits.key, { verdict: "fits", reason: "<b>Fencing</b> for council work", judged: "2026-11-08" } satisfies Verdict);
  await store.put("fit", no.key, { verdict: "no", reason: "Wrong trade", judged: "2026-11-08" } satisfies Verdict);

  assert.deepEqual(await digest(ctx), { digested: 1, waiting: 0 });
  assert.equal(drafts().length, 1, "one digest draft in the mailbox");
  assert.equal(sends().length, 0, "the digest is not sent by the cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].acts[0].op, "users.user.messages.message.send");

  const content: string = drafts().at(-1)!.body.body.content;
  assert.ok(content.includes("&lt;b&gt;Fencing"), "verdict reason is escaped");
  assert.ok(!content.includes("<img"), "alert title is escaped");
  assert.equal((await store.get<Opportunity>("opportunities", no.key))!.status, "dismissed");

  assert.deepEqual(await digest(ctx), { digested: 0, waiting: 0 });
  assert.equal(drafts().length, 1, "a second run the same day drafts nothing new");
});

test("approval runs the one send, and it reaches the mailbox's draft", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await scan(ctx); await logOpportunities(ctx);
  const opp = Object.values(await store.list<Opportunity>("opportunities"))[0];
  await store.put("fit", opp.key, { verdict: "maybe", reason: "Check the value", judged: "2026-11-08" } satisfies Verdict);
  await digest(ctx);
  const ap = Object.values(await store.list<Approval>("approvals"))[0];
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(decodeURIComponent(sends()[0].path), "/v1.0/users/tenders@example.com.au/messages/AAMkDraft1/send");
});
