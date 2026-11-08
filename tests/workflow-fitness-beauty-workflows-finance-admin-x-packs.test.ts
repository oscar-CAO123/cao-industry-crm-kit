// Packs and gift cards workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { giftCardBalances, reconcileDeferred } from "../industries/fitness-beauty/workflows/finance-admin/x-packs/index.ts";

const FOLDER = "industries/fitness-beauty/workflows/finance-admin/x-packs";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { business_name: "Test Studio", gift_card_state: "ACTIVE" };

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let cardPages: Record<string, unknown> = {};

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p === "/v2/gift-cards" && m === "GET") return json(cardPages[u.searchParams.get("cursor") ?? "first"]);
      if (p.endsWith("/Reports/TrialBalance") && m === "GET") return json({ Reports: [{ ReportName: "Trial Balance" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  cardPages = {
    first: { gift_cards: [
      { id: "GC1", state: "ACTIVE", balance_money: { amount: 5000, currency: "AUD" } },
      { id: "bad id;drop", state: "ACTIVE", balance_money: { amount: 100, currency: "AUD" } },
    ], cursor: "c2" },
    c2: { gift_cards: [{ id: "GC2", state: "ACTIVE", balance_money: { amount: 2550, currency: "AUD" } }] },
  };
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a write, and this workflow queues nothing", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "square", op: "api.CreateGiftCard", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createCreditNotes", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.CreateGiftCardActivity", summary: "x" }), /not a live operation/);
});

test("gift-card balances: reads every page, skips a bad id, and writes only its snapshot", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await giftCardBalances(ctx), { cards: 2, total_cents: 7550, skipped: 1, truncated: false });
  assert.ok(hits.every((h) => h.method === "GET"), "only reads reach the platform");
  const pages = hits.filter((h) => h.path === "/v2/gift-cards");
  assert.equal(pages.length, 2);
  assert.match(pages[0].search, /state=ACTIVE/);
  assert.equal((await store.get<any>("gift-card-balances", "2026-11-09"))?.total_cents, 7550);
  assert.deepEqual(await store.list("approvals"), {}, "nothing queued for approval");
});

test("gift-card balances: a re-run the same day overwrites that day's snapshot", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await giftCardBalances(ctx);
  await giftCardBalances(ctx);
  assert.equal(Object.keys(await store.list("gift-card-balances")).length, 1);
});

test("reconcile-deferred: reads last month's trial balance, writes nothing, and a re-run keeps one copy", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await reconcileDeferred(ctx), { date: "2026-10-31" });
  await reconcileDeferred(ctx);
  const trial = hits.filter((h) => h.path.endsWith("/Reports/TrialBalance"));
  assert.equal(trial.length, 2);
  assert.match(trial[0].search, /date=2026-10-31/);
  assert.ok(hits.every((h) => h.method === "GET" || /token$/.test(h.path)), "no write reaches Xero");
  assert.equal(Object.keys(await store.list("trial-balance")).length, 1);
  assert.deepEqual(await store.list("approvals"), {}, "nothing queued for approval");
});
