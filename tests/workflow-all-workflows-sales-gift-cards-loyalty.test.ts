// Gift cards and loyalty workflow tests. Every request goes to a fake network: no test reaches a real Square account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { activity, balances, issue, CRONS } from "../industries/all/workflows/sales/gift-cards-loyalty/index.ts";
import { keyOf, type LoyaltyMember, type Request } from "../industries/all/workflows/sales/gift-cards-loyalty/types.ts";

const DIR = "industries/all/workflows/sales/gift-cards-loyalty";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const LOC = "LOC1234ABCD";
const PROGRAM = "LP1234ABCD";

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let acts: { id: string; type: string; gift_card_id: string; amount: number; created_at: string }[] = [];
let accounts: Record<string, number> = {};
let counter = 0;

/** 230 hourly activities from 2 November 2026, in ascending order. Each carries an amount in its details block. */
function seed() {
  acts = Array.from({ length: 230 }, (_, i) => ({
    id: `GA${String(i).padStart(4, "0")}`,
    type: ["ACTIVATE", "LOAD", "REDEEM"][i % 3],
    gift_card_id: `GC${i % 7}`,
    amount: 1000 + i,
    created_at: new Date(Date.parse("2026-11-02T00:00:00Z") + i * 3600e3).toISOString(),
  }));
}

function toActivity(a: (typeof acts)[number]) {
  return {
    id: a.id, type: a.type, location_id: LOC, created_at: a.created_at, gift_card_id: a.gift_card_id,
    [`${a.type.toLowerCase()}_activity_details`]: { amount_money: { amount: a.amount, currency: "AUD" } },
  };
}

function fake() {
  hits = []; counter = 0; accounts = { LA0001: 1200, LA0002: 300 }; seed();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v2/gift-cards/activities" && m === "GET") {
        const begin = Date.parse(u.searchParams.get("begin_time") ?? "");
        const from = acts.filter((a) => Date.parse(a.created_at) >= begin);
        const off = Number(u.searchParams.get("cursor") ?? 0);
        const page = from.slice(off, off + 100);
        const next = off + 100 < from.length ? String(off + 100) : undefined;
        return json({ gift_card_activities: page.map(toActivity), ...(next ? { cursor: next } : {}) });
      }
      if (p === "/v2/loyalty/programs" && m === "GET") return json({ programs: [{ id: PROGRAM, type: "POINTS" }] });
      const acct = /^\/v2\/loyalty\/accounts\/([^/]+)$/.exec(p);
      if (acct && m === "GET") {
        const id = decodeURIComponent(acct[1]);
        return id in accounts ? json({ loyalty_account: { id, balance: accounts[id] } }) : json({ errors: [{ code: "NOT_FOUND" }] }, 404);
      }
      if (p === "/v2/gift-cards" && m === "POST") { counter++; return json({ gift_card: { id: `GC_NEW${counter}`, type: "DIGITAL", state: "PENDING" } }); }
      if (p === "/v2/gift-cards/activities" && m === "POST") return json({ gift_card_activity: { id: "GA_NEW", type: "ACTIVATE", gift_card_id: body?.gift_card_activity?.gift_card_id } });
      if (p === "/v2/loyalty/accounts" && m === "POST") { counter++; return json({ loyalty_account: { id: `LA_NEW${counter}`, program_id: PROGRAM, balance: 0 } }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const S: any = { business_name: "Test Cafe", location_id: LOC, loyalty_program_id: PROGRAM, activity_days: 7, per_run: 20, max_pages: 10 };
const at = (store: MemoryStore, s: any = S, when = NOW) => context(WF, s, store, when, () => {});
const req = (over: Partial<Request> & { key: string; kind: Request["kind"] }): Request =>
  ({ status: "new", created: NOW.toISOString(), ...over }) as Request;

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq-test-token", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation or queue a read; refused settings never reach the network", async () => {
  const ctx = at(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "square", op: "api.CreateGiftCard", input: { body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.ListGiftCardActivities", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
  await assert.rejects(activity(at(new MemoryStore(), { ...S, location_id: "bad id/../x" })), /location_id/);
  await assert.rejects(balances(at(new MemoryStore(), { ...S, loyalty_program_id: "../x" })), /loyalty_program_id/);
  assert.equal(hits.length, 0);
});

test("activity reads every page of gift card activity, writes the ledger once, and only reads", async () => {
  const store = new MemoryStore();
  const ctx = at(store);
  const first = await activity(ctx);
  assert.equal(first.read, 230);
  assert.equal(first.added, 230);
  assert.equal(hits.filter((h) => h.method === "GET").length, 3, "three pages of 100 with a cursor");
  assert.ok(hits.every((h) => h.method === "GET"), "activity only reads");
  assert.equal(hits[0].query.get("location_id"), LOC);
  assert.equal(hits[0].query.get("sort_order"), "ASC");
  assert.equal(hits[0].query.get("begin_time"), "2026-11-01T00:00:00.000Z", "first read looks back 7 days");
  assert.equal(Object.keys(await store.list("ledger")).length, 230);
  const row = await store.get<{ amount_cents?: number; type: string }>("ledger", keyOf("GA0000"));
  assert.equal(row?.amount_cents, 1000);
  assert.equal(row?.type, "ACTIVATE");
  const second = await activity(ctx);
  assert.equal(second.read, 1, "the next run starts from the last activity seen and reads it again");
  assert.equal(second.added, 0, "the ledger does not take the same activity twice");
});

test("balances reads the loyalty program and each enrolled member's balance, and writes nothing to Square", async () => {
  const store = new MemoryStore();
  for (const id of ["LA0001", "LA0002"]) await store.put("loyalty", keyOf(id), { key: keyOf(id), id } satisfies LoyaltyMember);
  assert.deepEqual(await balances(at(store)), { program_found: true, read: 2 });
  assert.ok(hits.every((h) => h.method === "GET"), "balances only reads");
  assert.equal((await store.get<LoyaltyMember>("loyalty", keyOf("LA0001")))?.balance, 1200);
  assert.equal((await store.get<LoyaltyMember>("loyalty", keyOf("LA0002")))?.balance, 300);
});

test("issue queues card and enrolment approvals without sending, then issues, activates and enrols only once each", async () => {
  const store = new MemoryStore();
  const ctx = at(store);
  await store.put("requests", "req-card-1", req({ key: "req-card-1", kind: "gift-card", amount_cents: 5000 }));
  await store.put("requests", "req-card-bad", req({ key: "req-card-bad", kind: "gift-card", amount_cents: 50 }));
  await store.put("requests", "req-enrol-1", req({ key: "req-enrol-1", kind: "loyalty-enrol", phone: "+61400000001" }));
  await store.put("requests", "req-enrol-bad", req({ key: "req-enrol-bad", kind: "loyalty-enrol", phone: "0400 000 001" }));

  assert.deepEqual(await issue(ctx), { queued: 2, skipped: 2 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "a cron never creates anything itself");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending"));
  assert.equal((await store.get<Request>("requests", "req-card-bad"))?.status, "skipped");
  assert.equal((await store.get<Request>("requests", "req-enrol-bad"))?.status, "skipped");
  assert.deepEqual(await issue(ctx), { queued: 0, skipped: 0 }, "a second run queues nothing new");

  // Approve the card: POST /v2/gift-cards, the id comes back, and the request becomes issued.
  const cardAp = (await store.get<Request>("requests", "req-card-1"))!.approval!;
  assert.equal((await approve(WF, store, cardAp, "owner", NOW)).status, "done");
  const createCard = hits.find((h) => h.method === "POST" && h.path === "/v2/gift-cards")!;
  assert.equal(createCard.body.location_id, LOC);
  assert.equal(createCard.body.gift_card.type, "DIGITAL");
  assert.match(createCard.body.idempotency_key, /^gc-[0-9a-f]{40}$/);
  await issue(ctx);
  const card = await store.get<Request>("requests", "req-card-1");
  assert.equal(card?.status, "issued");
  assert.equal(card?.gift_card_id, "GC_NEW1");

  // Staff set the paid order: the next run queues the activation, and nothing runs until approval.
  await store.put("requests", "req-card-1", { ...card!, order_id: "ORDER0001" });
  assert.deepEqual(await issue(ctx), { queued: 1, skipped: 0 });
  assert.equal(hits.filter((h) => h.path === "/v2/gift-cards/activities").length, 0, "activation is queued, not run");
  const actAp = (await store.get<Request>("requests", "req-card-1"))!.activate_approval!;
  assert.equal((await approve(WF, store, actAp, "owner", NOW)).status, "done");
  const activation = hits.find((h) => h.method === "POST" && h.path === "/v2/gift-cards/activities")!;
  assert.equal(activation.body.gift_card_activity.type, "ACTIVATE");
  assert.equal(activation.body.gift_card_activity.gift_card_id, "GC_NEW1");
  assert.deepEqual(activation.body.gift_card_activity.activate_activity_details.amount_money, { amount: 5000, currency: "AUD" });
  assert.equal(activation.body.gift_card_activity.activate_activity_details.order_id, "ORDER0001");
  await issue(ctx);
  assert.equal((await store.get<Request>("requests", "req-card-1"))?.status, "activated");

  // Approve the enrolment: POST /v2/loyalty/accounts, and the new account is kept for the balances read.
  const enrolAp = (await store.get<Request>("requests", "req-enrol-1"))!.approval!;
  assert.equal((await approve(WF, store, enrolAp, "owner", NOW)).status, "done");
  const enrol = hits.find((h) => h.method === "POST" && h.path === "/v2/loyalty/accounts")!;
  assert.equal(enrol.body.loyalty_account.program_id, PROGRAM);
  assert.equal(enrol.body.loyalty_account.mapping.phone_number, "+61400000001");
  assert.match(enrol.body.idempotency_key, /^ena-[0-9a-f]{40}$/);
  await issue(ctx);
  const member = await store.get<Request>("requests", "req-enrol-1");
  assert.equal(member?.status, "enrolled");
  assert.ok(member?.loyalty_account_id);
  assert.ok(await store.get("loyalty", keyOf(member!.loyalty_account_id!)), "the new member is kept for the balances read");
});

test("a rejected card is skipped for good and is never queued again", async () => {
  const store = new MemoryStore();
  const ctx = at(store);
  await store.put("requests", "req-card-2", req({ key: "req-card-2", kind: "gift-card", amount_cents: 2000 }));
  assert.deepEqual(await issue(ctx), { queued: 1, skipped: 0 });
  const ap = (await store.get<Request>("requests", "req-card-2"))!.approval!;
  await reject(WF, store, ap, "owner", NOW);
  await issue(ctx);
  const after = await store.get<Request>("requests", "req-card-2");
  assert.equal(after?.status, "skipped");
  assert.match(after?.reason ?? "", /rejected/);
  assert.deepEqual(await issue(ctx), { queued: 0, skipped: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "no second approval for the same request");
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("workflow.json and the crons agree: draft ops are reads only, live ops are the three writes, every cron is listed and exported", () => {
  assert.deepEqual([...WF.draft_ops.square].sort(), ["api.ListGiftCardActivities", "api.ListLoyaltyPrograms", "api.RetrieveLoyaltyAccount"]);
  assert.deepEqual([...WF.live_ops.square].sort(), ["api.CreateGiftCard", "api.CreateGiftCardActivity", "api.CreateLoyaltyAccount"]);
  assert.ok(!WF.draft_ops.square.some((op) => /Create|Update|Delete|Redeem|Accumulate|Adjust|Cancel|Refund|Pay|Send|Bulk/.test(op)), "no write in draft ops");
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "gift-cards-loyalty");
  assert.equal(WF.crons.length, 3);
});
