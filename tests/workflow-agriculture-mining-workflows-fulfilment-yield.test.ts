// Yield-and-waste workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import { intake, yieldCheck, ownerReport, CRONS } from "../industries/agriculture-mining/workflows/fulfilment/yield/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agriculture-mining/workflows/fulfilment/yield/workflow.json", "utf8")) as WorkflowRecord;
const BOX = "shed@example.com.au", OWNER = "owner@example.com.au", MSG = "AAMkDraft1";
const DRIVE = { drive: "DRIVE1", item: "ITEM1", table: "YieldRegister" }, EXC = { drive: "DRIVE1", item: "ITEM1", table: "YieldExceptions" };
const NOW = new Date("2026-11-08T22:00:00Z");   // Sunday night UTC, Monday morning in Sydney; the report covers 2 to 8 November

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let register: unknown[][] = [];

// Register rows: [Date, Lot, Area, Gross kg, Packed kg, Waste kg]
const ROWS = () => [
  ["2026-11-03", "PG-0301", "Shed 2", 12000, 10800, 600],     // 90% yield, 5% waste: fine
  ["2026-11-05", "GA-0502", "Shed 1", 8000, 6000, 1000],      // 75% yield, 12.5% waste: both flagged
  ["2026-11-05", "bad lot!", "Shed 1", 100, 90, 5],           // lot code refused
  ["2026-11-06", "PG-0602", "Shed 2", 5000, 4900, 300],       // packed plus waste over gross: refused
];

function fake() {
  hits = []; register = ROWS();
  process.env.M365_ACCESS_TOKEN = "ms";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/rows") && m === "GET") return json({ value: register.map((v, i) => ({ index: i, values: [v] })) });
      if (p.endsWith("/rows")) return json({ index: 0 });
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: MSG });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = (suffix: string) => hits.filter((h) => h.method === "POST" && h.path.endsWith(suffix));
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const SETTINGS: any = {
  business_name: "Example Packing Co", owner_email: OWNER,
  microsoft_365: { mailbox: BOX, register: DRIVE, exceptions: EXC }, expected_yield_pct: 85, waste_alert_pct: 8,
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  process.env.KIT_ALLOW_WRITES = "1";
});

test("every draft and live operation in workflow.json is mapped in the kit", () => {
  for (const [platform, ops] of Object.entries({ ...WF.draft_ops, ...(WF as any).live_ops }))
    for (const op of ops as string[]) assert.doesNotThrow(() => describe(platform, op), `${platform} ${op}`);
  for (const c of WF.crons) assert.ok(CRONS[c.entry], `${c.entry} is exported`);
});

test("runtime: a cron cannot send through a draft, and cannot queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
});

test("the SDK gate still blocks the exception write when the deploy does not allow writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(yieldCheck(ctx), WriteBlocked);
  assert.equal(writes("/rows").length, 0);
});

test("intake: stores the lots that add up, refuses the rest, and a second run adds nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2, read: 2, rejected: 2 });
  const lots = Object.values(await store.list<any>("lots")).map((l) => l.lot).sort();
  assert.deepEqual(lots, ["GA-0502", "PG-0301"]);
  assert.deepEqual(await intake(ctx), { added: 0, read: 2, rejected: 2 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("yield-check: one exception per lot under target or over the waste limit, written once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await yieldCheck(ctx), { raised: 1, written: 1, checked: 2 });
  const rows = writes("/rows");
  assert.equal(rows.length, 1);
  const [row] = rows[0].body.values;
  assert.equal(row[1], "GA-0502");
  assert.equal(row[2], 75);
  assert.equal(row[3], 12.5);
  assert.match(row[4], /yield 75% is under the 85% target; waste 12.5% is over the 8% limit/);
  assert.deepEqual(await yieldCheck(ctx), { raised: 0, written: 0, checked: 2 }, "a re-run never writes the same exception again");
  assert.equal(writes("/rows").length, 1);
});

test("owner-report: drafts the week, queues one send, and a re-run neither drafts nor queues again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await yieldCheck(ctx);
  assert.deepEqual(await ownerReport(ctx), { queued: 1, week: "2026-11-02", lots: 2 });
  assert.equal(sends().length, 0, "the report is drafted, not sent");
  const draft = writes("/messages")[0].body;
  assert.equal(draft.toRecipients[0].emailAddress.address, OWNER);
  assert.match(draft.body.content, /week of 2026-11-02: 2 lots/);
  assert.match(draft.body.content, /GA-0502: yield 75% is under the 85% target/);
  assert.equal(draft.body.content.includes("<script"), false);
  assert.equal((await ownerReport(ctx)).queued, 0);
  assert.equal(writes("/messages").length, 1, "one draft for the week");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "one approval queued");
  assert.match(pending[0].summary, /to owner@example\.com\.au: 2 lots, 84% yield, 8% waste/);
});

test("approval runs the one send, once, and a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await yieldCheck(ctx); await ownerReport(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(decodeURIComponent(sends()[0].path), `/v1.0/users/${BOX}/messages/${MSG}/send`);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("a report for a new week drafts and queues again, and an empty week still reports", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  const next = new Date("2026-11-15T22:00:00Z");
  const r = await ownerReport(context(WF, SETTINGS, store, next, () => {}));
  assert.deepEqual(r, { queued: 1, week: "2026-11-09", lots: 0 });
  assert.equal(writes("/messages").length, 1);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
});
