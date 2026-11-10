// Arrears ladder workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { scan, remind, CRONS } from "../industries/real-estate/workflows/finance-admin/add-arrears/index.ts";

const FOLDER = "industries/real-estate/workflows/finance-admin/add-arrears";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const BOX = "arrears@example.com.au", DRAFT = "AAMkDraft1";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let paid = new Set<string>();

// A: two days overdue, valid email. B: 19 days overdue, no valid email. C: not due yet.
const INVOICES = [
  { Id: A, DisplayId: "INV-0001", Status: "AUTHORISED", DueDate: "2026-11-06T00:00:00Z", AmountDue: 1850, Total: 1850,
    Contact: { Id: "c1", Name: "Sam Tenant", FirstName: "Sam", Email: "sam@example.com" }, Property: { Id: "p1", Address: "1 Test St" } },
  { Id: B, DisplayId: "INV-0002", Status: "AUTHORISED", DueDate: "2026-10-20T00:00:00Z", AmountDue: 900, Total: 900,
    Contact: { Id: "c2", Name: "Lee Tenant", FirstName: "Lee", Email: "not-an-email" }, Property: { Id: "p2", Address: "2 Test St" } },
  { Id: C, DisplayId: "INV-0003", Status: "AUTHORISED", DueDate: "2026-11-10T00:00:00Z", AmountDue: 1200, Total: 1200,
    Contact: { Id: "c3", Name: "Kim Tenant", FirstName: "Kim", Email: "kim@example.com" }, Property: { Id: "p3", Address: "3 Test St" } },
];

const SET: any = { business_name: "Test Property", microsoft_365: { mailbox: BOX },
  register: { drive: "DRIVE1", item: "ITEM1", table: "ArrearsRegister" }, max_pages: 2 };

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname === "api.re-leased.com") {
        if (p === "/api/invoices" && m === "GET") return json({ Data: u.searchParams.get("fromId") ? [] : INVOICES });
        const one = p.match(/^\/api\/invoices\/([^/]+)$/);
        if (one && m === "GET") {
          const inv = INVOICES.find((i) => i.Id === one[1]);
          if (!inv) return new Response("not found", { status: 404 });
          return json({ Data: paid.has(inv.Id) ? { ...inv, AmountDue: 0, Status: "PAID" } : inv });
        }
        return new Response("not faked: " + p, { status: 404 });
      }
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const rows = () => hits.filter((h) => h.path.endsWith("/rows"));
const pending = async (store: MemoryStore) =>
  Object.values(await store.list<Approval>("approvals")).filter((a) => a.workflow === WF.id && a.status === "pending");

beforeEach(() => {
  paid = new Set();
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { RELEASED_ACCESS_TOKEN: "r", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons are wired by entry name", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["remind", "scan"]);
});

test("a live operation cannot be drafted and a draft cannot be queued", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "re-leased", op: "Invoices_Get", summary: "x" }), /not a live operation/);
});

test("scan adds each overdue invoice once, skips invoices not yet due, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await scan(ctx), { added: 2 });
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].body.values[0][0], "INV-0001");
  assert.deepEqual(await scan(ctx), { added: 0 });
  assert.equal(rows().length, 2, "re-runs never add a register row twice");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("remind queues one reminder at the highest step reached, never sends, and skips a bad email", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await scan(ctx);
  assert.deepEqual(await remind(ctx), { queued: 1, skipped: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const p = await pending(store);
  assert.equal(p.length, 1);
  assert.equal(p[0].acts[0].op, "users.user.messages.message.send");
  assert.equal(p[0].acts[0].input?.params?.["message-id"], DRAFT);
  const draft = hits.find((h) => h.path.endsWith("/messages") && h.method === "POST");
  assert.equal(draft?.body.toRecipients[0].emailAddress.address, "sam@example.com");
});

test("re-runs never queue a reminder twice, and an approved reminder sends once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await scan(ctx);
  await remind(ctx); await remind(ctx);
  const p = await pending(store);
  assert.equal(p.length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, p[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, p[0].id, "owner"), /already done/);
});

test("an invoice paid after the scan gets no reminder", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await scan(ctx);
  paid.add(A);
  assert.deepEqual(await remind(ctx), { queued: 0, skipped: 2 });
  assert.equal((await pending(store)).length, 0);
});

test("one invoice whose re-read fails does not stop the reminders after it", async () => {
  const GONE = "44444444-4444-4444-8444-444444444444";
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  // Stored first, so it comes first in store order every day. The API no longer has it (404).
  await store.put("arrears", GONE, { id: GONE, display: "INV-0009", property: "9 Test St", contact: "Gone", first: "G",
    email: "gone@example.com", due: "2026-11-01", amount: 300, first_seen: "2026-11-02" });
  await scan(ctx);
  assert.deepEqual(await remind(ctx), { queued: 1, skipped: 2 });
  const p = await pending(store);
  assert.equal(p.length, 1, "the invoice after the failed one still gets its reminder");
  assert.equal(p[0].acts[0].input?.params?.["message-id"], DRAFT);
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("the run log never carries the tenant's address from the draft step", async () => {
  const logs: string[] = [];
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, (m) => logs.push(m));
  await scan(ctx);
  await remind(ctx);
  assert.ok(logs.some((l) => l.startsWith("draft ")), "the draft step is logged");
  assert.ok(logs.filter((l) => l.startsWith("draft ")).every((l) => !l.includes("sam@example.com")));
});
