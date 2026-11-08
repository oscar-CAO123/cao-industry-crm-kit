// Trust accounting workflow tests. Every request goes to a fake network: no test reaches a real Smokeball account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { balances, receipts, disbursements } from "../industries/professional-services/workflows/finance-admin/x-trust/index.ts";
import type { Request, Settings, Flag } from "../industries/professional-services/workflows/finance-admin/x-trust/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/finance-admin/x-trust/workflow.json", "utf8")) as WorkflowRecord;
const A1 = "a1b2c3d4-0000-4000-8000-000000000001";
const M1 = "11111111-0000-4000-8000-000000000001", M2 = "11111111-0000-4000-8000-000000000002", M3 = "11111111-0000-4000-8000-000000000003";
const P1 = "22222222-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `/bankaccounts/${A1}/matter-balances`) return json({ value: [
        { matter: { id: M1 }, balance: 1000, availableBalance: 1000 },
        { matter: { id: M2 }, balance: -50, availableBalance: -50 },
        { matter: { id: M3 }, balance: 300, availableBalance: 300 },
      ] });
      if (p === `/bankaccounts/${A1}/transactions`) return json({ value: [
        { id: "T1", type: "Deposit", amount: 500, matter: { id: M1 }, enteredDate: "2026-11-08T00:00:00Z" },
        { id: "T2", type: "Deposit", amount: 200, matter: null, enteredDate: "2026-11-08T01:00:00Z" },
      ] });
      if (p === `/bankaccounts/${A1}/requisitions` && m === "POST") return json({ id: "R1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: Settings = {
  trust: "smokeball", trust_accounts: [{ id: A1, name: "General trust" }], min_matter_balance: 0,
};
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SMOKEBALL_ACCESS_TOKEN: "tok", SMOKEBALL_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
  delete process.env.SMOKEBALL_REGION_TLD;
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "smokeball", op: "CreateRequisitionAsync", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "smokeball", op: "GetTransactions", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("balance and receipt crons flag each problem once and never write to Smokeball", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await balances(ctx), { flagged: 1 });
  assert.deepEqual(await receipts(ctx), { flagged: 1 });
  assert.deepEqual(await balances(ctx), { flagged: 0 }, "a re-run never raises the same flag twice");
  assert.deepEqual(await receipts(ctx), { flagged: 0 });
  const flags = Object.values(await store.list<Flag>("flags"));
  assert.deepEqual(flags.map((f) => f.kind).sort(), ["negative-matter-balance", "unallocated-transaction"]);
  assert.equal(writes().length, 0, "reads only");
});

test("a disbursement inside the matter's trust balance is queued, not sent, and runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  const req: Request = { id: "req-1", account_id: A1, matter_id: M1, payee_id: P1, amount: 400, reference: "Settlement", status: "requested", requested_at: NOW.toISOString() };
  await store.put("requests", req.id, req);
  assert.deepEqual(await disbursements(ctx), { queued: 1, parked: 0 });
  assert.equal(writes().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "CreateRequisitionAsync");
  assert.deepEqual(await disbursements(ctx), { queued: 0, parked: 0 }, "a queued request is never queued again");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const sent = writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, `/bankaccounts/${A1}/requisitions`);
  assert.equal(sent[0].body.matterId, M1);
  assert.equal(sent[0].body.payeeId, P1);
  assert.equal(sent[0].body.amount, 400);
  assert.equal(sent[0].body.source, "Bank Transfer");
});

test("a disbursement above the matter's trust balance is parked and never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("requests", "req-2", { id: "req-2", account_id: A1, matter_id: M3, payee_id: P1, amount: 500, status: "requested", requested_at: NOW.toISOString() } satisfies Request);
  assert.deepEqual(await disbursements(ctx), { queued: 0, parked: 1 });
  const r = await store.get<Request>("requests", "req-2");
  assert.equal(r!.status, "needs-check");
  assert.match(r!.reason_parked!, /below/);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
});

test("bad ids, bad amounts and accounts outside settings are refused before any call", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  const base = { account_id: A1, matter_id: M1, payee_id: P1, amount: 10, status: "requested" as const, requested_at: NOW.toISOString() };
  await store.put("requests", "bad-payee", { ...base, id: "bad-payee", payee_id: "../x" } satisfies Request);
  await store.put("requests", "bad-cents", { ...base, id: "bad-cents", amount: 10.555 } satisfies Request);
  await store.put("requests", "other-acct", { ...base, id: "other-acct", account_id: "ZZ" } satisfies Request);
  assert.deepEqual(await disbursements(ctx), { queued: 0, parked: 3 });
  for (const id of ["bad-payee", "bad-cents", "other-acct"]) assert.equal((await store.get<Request>("requests", id))!.status, "needs-check");
  assert.equal(writes().length, 0);
});
