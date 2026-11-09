// Trust reconciliation workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { accounts, ledger, CRONS } from "../industries/real-estate/workflows/finance-admin/add-trust/index.ts";

const FOLDER = "industries/real-estate/workflows/finance-admin/add-trust";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const BOX = "finance@example.com.au", PRINCIPAL = "principal@example.com.au", DRAFT = "AAMkDraft2";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let accountsNow: { id: number; name: string; accountNumber: string; bsbNumber: string; type: string }[] = [];
let badAccounts = false, failDraft = false;

// Entry 9001 is complete. 9002 has no receipt number and no contact, and its type name holds markup that must be escaped. 9003 is complete.
const TXS = [
  { id: 9001, saleLifeId: 2001, transactionType: { id: 1, name: "Deposit" }, trustAccount: 77, receiptNumber: "R-100", category: { id: 5, name: "Deposit" },
    transactionDate: "2026-11-05", amount: 1500, contact: 4001, receivedFromText: "Buyer" },
  { id: 9002, saleLifeId: 2001, transactionType: { id: 2, name: "<b>Disbursement</b>" }, trustAccount: 77, receiptNumber: null, category: { id: 6, name: "Owner" },
    transactionDate: "2026-11-06", amount: 900, contact: null, receivedFromText: null },
  { id: 9003, saleLifeId: 2001, transactionType: { id: 1, name: "Deposit" }, trustAccount: 77, receiptNumber: "R-101", category: { id: 5, name: "Deposit" },
    transactionDate: "2026-11-07", amount: 400, contact: 4002, receivedFromText: "Tenant" },
];

const SET: any = { business_name: "Test Realty", microsoft_365: { mailbox: BOX }, principal_email: PRINCIPAL,
  register: { drive: "DRIVE1", item: "ITEM1", table: "TrustRegister" }, sale_lives: [{ property_id: 1001, life_id: 2001 }], max_pages: 3 };

function fake(txs = TXS) {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/account/trustAccounts") && m === "GET") return badAccounts ? json({ results: accountsNow }) : json({ items: accountsNow, totalItems: accountsNow.length, urls: {} });
      const led = p.match(/\/properties\/(\d+)\/sale\/(\d+)\/trustledger\/transactions$/);
      if (led && m === "GET") {
        const page = Number(u.searchParams.get("page") ?? "1");
        return json(page === 1 ? { items: txs, totalItems: txs.length, urls: { next: "next" } } : { items: [], urls: {} });
      }
      if (p.endsWith("/messages") && m === "POST") return failDraft ? new Response("{}", { status: 500 }) : json({ id: DRAFT });
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
  accountsNow = [{ id: 77, name: "Trust A", accountNumber: "000000000", bsbNumber: "000000", type: "sales" }];
  badAccounts = false; failDraft = false;
  fake();
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "v", VAULTRE_API_KEY: "k", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons are wired by entry name", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["accounts", "ledger"]);
  assert.equal(WF.crons.length, 2);
});

test("a live operation cannot be drafted and a draft cannot be queued", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "getTrustAccounts", summary: "x" }), /not a live operation/);
});

test("accounts adds a register row once when a trust account first appears, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await accounts(ctx), { accounts: 1, added: 1, dropped: 0 });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].body.values[0][1], "trust accounts");
  assert.deepEqual(await accounts(ctx), { accounts: 1, added: 0, dropped: 0 });
  assert.equal(rows().length, 1, "re-runs never add the same account twice");
  assert.equal(sends().length, 0);
});

test("accounts records a dropped trust account in the register", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await accounts(ctx);
  accountsNow = [];
  assert.deepEqual(await accounts(ctx), { accounts: 0, added: 0, dropped: 1 });
  assert.equal(rows().length, 2);
  assert.match(rows()[1].body.values[0][3], /dropped: 77 Trust A/);
});

test("ledger keeps new entries, writes one register row, and queues one exceptions email for the flagged entry only", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await ledger(ctx), { fresh: 3, flagged: 1, queued: true });
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].body.values[0][2], 3, "entry count in the row");
  assert.equal(rows()[0].body.values[0][4], 1, "flagged count in the row");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const draft = hits.find((h) => h.path.endsWith("/messages") && h.method === "POST");
  assert.equal(draft?.body.toRecipients[0].emailAddress.address, PRINCIPAL);
  assert.ok(!String(draft?.body.body.content).includes("<b>"), "markup from VaultRE is escaped in the email");
  assert.ok(String(draft?.body.body.content).includes("9002"));
  const p = await pending(store);
  assert.equal(p.length, 1);
  assert.equal(p[0].acts[0].op, "users.user.messages.message.send");
  assert.equal(p[0].acts[0].input?.params?.["message-id"], DRAFT);
});

test("re-runs add nothing, write no second row, and queue no second email", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await ledger(ctx);
  assert.deepEqual(await ledger(ctx), { fresh: 0, flagged: 0, queued: false });
  assert.equal(rows().length, 1, "re-runs never add a register row twice");
  assert.equal((await pending(store)).length, 1, "re-runs never queue twice");
  assert.equal(sends().length, 0);
});

test("an approved exceptions email sends once, and a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await ledger(ctx);
  const [p] = await pending(store);
  const ap = await approve(WF, store, p.id, "principal", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, p.id, "principal"), /already done/);
});

test("an entry that is already complete produces no email and no exception", async () => {
  fake(TXS.filter((t) => t.id !== 9002));
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await ledger(ctx), { fresh: 2, flagged: 0, queued: false });
  assert.equal((await pending(store)).length, 0);
});

test("a sale id that is not a number is refused before any call is made", async () => {
  const store = new MemoryStore();
  const bad = { ...SET, sale_lives: [{ property_id: "1001/../x", life_id: 2001 }] };
  await assert.rejects(ledger(context(WF, bad, store, NOW, () => {})), /numeric property_id/);
  assert.equal(hits.length, 0);
});

test("a failed exceptions draft leaves the flagged entry new, so the next run queues it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  failDraft = true;
  await assert.rejects(ledger(ctx));
  assert.equal(await store.get("trust_tx", "9002"), undefined, "the flagged entry is not saved as seen");
  assert.ok(await store.get("trust_tx", "9001"), "complete entries are saved");
  failDraft = false;
  assert.deepEqual(await ledger(ctx), { fresh: 1, flagged: 1, queued: true });
  assert.equal((await pending(store)).length, 1, "the exceptions email is queued once");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("flagged entries with no principal email stop the run before anything is written", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...SET, principal_email: undefined }, store, NOW, () => {});
  await assert.rejects(ledger(ctx), /principal_email/);
  assert.equal(rows().length, 0, "no register row");
  assert.equal(await store.get("trust_tx", "9001"), undefined, "no entry saved as seen");
  assert.equal((await pending(store)).length, 0);
});

test("a changed trust account reply stops the accounts cron and marks no account dropped", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await accounts(ctx);
  badAccounts = true;
  await assert.rejects(accounts(ctx), /no items list/);
  assert.equal(rows().length, 1, "no dropped row written");
  assert.equal((await store.get<any>("accounts", "77")).active, true);
});

test("the run log never carries the principal's address from the draft step", async () => {
  const logs: string[] = [];
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, (m) => logs.push(m));
  await ledger(ctx);
  assert.ok(logs.some((l) => l.startsWith("draft ")), "the draft step is logged");
  assert.ok(logs.filter((l) => l.startsWith("draft ")).every((l) => !l.includes(PRINCIPAL)));
});
