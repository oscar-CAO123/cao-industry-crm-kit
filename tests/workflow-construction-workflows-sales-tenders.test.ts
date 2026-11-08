// Tenders workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, interest, deadlines } from "../industries/construction/workflows/sales/tenders/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/sales/tenders/workflow.json", "utf8")) as WorkflowRecord;
const BOX = "tenders@example.com.au";
const NOTICE_ID = "AAMkTender1";
const REF = "m365:AAMkTender1";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let rows: unknown[][] = [];   // register rows as Excel returns them: [date, ref, tender, principal, email, closes, status]
let drafts = 0;

function fake() {
  hits = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.includes("/mailFolders/")) return json({ value: [{ id: NOTICE_ID, subject: "Tender: stormwater upgrade",
        from: { emailAddress: { name: "Ari Patel", address: "ari@principal.example" } }, receivedDateTime: "2026-11-08T23:00:00Z", bodyPreview: "Tender docs attached" }] });
      if (p.endsWith("/rows") && m === "GET") return json({ value: rows.map((r) => ({ values: [r] })) });
      if (p.endsWith("/rows")) return json({ index: 0 });
      if (p.endsWith("/messages") && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const creates = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const S: any = { family: "tender-bid", business_name: "Test Civil",
  microsoft_365: { mailbox: BOX, folder: "inbox", search: "tender", register: { drive: "DRIVE1", item: "ITEM1", table: "TenderRegister" } },
  reminder_to: "owner@example.com.au", warn_days: 5 };

beforeEach(() => {
  fake(); rows = []; setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("the SDK gate blocks the register write when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), WriteBlocked);
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("intake logs each notice once in the register and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 }, "a second run finds nothing new");
  const logged = hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].body.values[0].slice(1, 3), [REF, "Tender: stormwater upgrade"]);
  assert.equal(sends().length, 0);
});

test("a Go tender gets an expression of interest drafted and queued, and is sent only when approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  rows = [["2026-11-09", REF, "Stormwater upgrade", "Ari Patel", "ari@principal.example", "2026-11-20", "Go"]];
  assert.deepEqual(await interest(ctx), { queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(creates().length, 1, "one Outlook draft");
  assert.deepEqual(await interest(ctx), { queued: 0 }, "a second run queues nothing new");
  assert.equal(creates().length, 1, "and drafts nothing new");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].acts.map((a) => a.op), ["users.user.messages.message.send"]);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.ok(sends()[0].path.endsWith("/AAMkDraft1/send"));
  await assert.rejects(approve(WF, store, pending[0].id, "owner", NOW), /already done/);
});

test("deadlines drafts one reminder to the business for tenders closing soon, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  rows = [
    ["2026-11-09", REF, "Stormwater upgrade", "Ari Patel", "ari@principal.example", "2026-11-12", "Go"],
    ["2026-11-09", "m365:AAMkTender2", "Depot fit-out", "", "", "2026-12-30", "Check go or no-go"],
    ["2026-11-09", "m365:AAMkTender3", "Old bridge", "", "", "2026-11-11", "Submitted"],
    ["2026-11-09", "m365:AAMkTender4", "Council & resurfacing", "", "", "", "Check go or no-go"],
  ];
  assert.deepEqual(await deadlines(ctx), { reminded: 2, draft: "AAMkDraft1" });
  assert.equal(creates().length, 1);
  const d = creates()[0].body;
  assert.equal(d.toRecipients[0].emailAddress.address, "owner@example.com.au");
  assert.match(d.body.content, /Stormwater upgrade, closes in 3 days/);
  assert.match(d.body.content, /Council &amp; resurfacing, no closing date entered/);
  assert.doesNotMatch(d.body.content, /Old bridge|Depot/);
  assert.equal(sends().length, 0);
  assert.equal(Object.keys(await store.list("approvals")).length, 0, "nothing queued");
});
