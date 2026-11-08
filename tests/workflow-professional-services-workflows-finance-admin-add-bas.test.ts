// BAS first-pass workflow tests. Every request goes to a fake network: no test reaches a real Xero organisation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pullPeriod, codeLines, exceptions, CRONS } from "../industries/professional-services/workflows/finance-admin/add-bas/index.ts";
import fs from "node:fs";

const DIR = "industries/professional-services/workflows/finance-admin/add-bas";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = {
  family: "accounting-practice", business_name: "Test Accounting", period_start: "2026-10-01",
  coding_rules: [{ match: "telstra", account_code: "408", tax_type: "INPUT" }],
};
const NOW = new Date("2026-11-09T00:00:00Z");

const A = "11111111-1111-4111-8111-111111111111"; // single line, uncoded, a Telstra rule matches, has a document
const B = "22222222-2222-4222-8222-222222222222"; // single line, uncoded, no rule matches, no document
const C = "33333333-3333-4333-8333-333333333333"; // two lines
const D = "44444444-4444-4444-8444-444444444444"; // already coded, has a document
const CONTACT = "55555555-5555-4555-8555-555555555555";

const TXNS = [
  { BankTransactionID: A, Type: "SPEND", Date: "/Date(1793491200000+0000)/", Contact: { Name: "Telstra", ContactID: CONTACT },
    Reference: "INV 8812", LineAmountTypes: "Inclusive", Total: -110, HasAttachments: true, IsReconciled: false,
    LineItems: [{ Description: "Telstra mobile plan", LineAmount: -110, TaxType: "INPUT" }] },
  { BankTransactionID: B, Type: "SPEND", Date: "/Date(1793491200000+0000)/", Contact: { Name: "Unknown Pty Ltd" },
    Reference: "", LineAmountTypes: "Inclusive", Total: -55, HasAttachments: false, IsReconciled: false,
    LineItems: [{ Description: "Misc supplies", LineAmount: -55, TaxType: "INPUT" }] },
  { BankTransactionID: C, Type: "SPEND", Date: "/Date(1793491200000+0000)/", Contact: { Name: "Officeworks" },
    Reference: "", LineAmountTypes: "Inclusive", Total: -220, HasAttachments: true, IsReconciled: false,
    LineItems: [{ Description: "Paper", LineAmount: -100, TaxType: "INPUT" }, { Description: "Toner", LineAmount: -120, TaxType: "INPUT" }] },
  { BankTransactionID: D, Type: "SPEND", Date: "/Date(1793491200000+0000)/", Contact: { Name: "Officeworks" },
    Reference: "", LineAmountTypes: "Inclusive", Total: -33, HasAttachments: true, IsReconciled: false,
    LineItems: [{ Description: "Office supplies", LineAmount: -33, AccountCode: "400", TaxType: "INPUT" }] },
];
const RATES = [
  { TaxType: "INPUT", Name: "GST on Expenses", Status: "ACTIVE", EffectiveRate: 10 },
  { TaxType: "OUTPUT", Name: "GST on Income", Status: "ACTIVE", EffectiveRate: 10 },
  { TaxType: "OLDTAX", Name: "Retired rate", Status: "ARCHIVED", EffectiveRate: 5 },
];

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];

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
      if (p.endsWith("/BankTransactions") && m === "GET") return json({ BankTransactions: u.searchParams.get("page") === "1" ? TXNS : [] });
      if (p.endsWith("/TaxRates") && m === "GET") return json({ TaxRates: RATES });
      if (/\/BankTransactions\/[^/]+$/.test(p) && m === "POST") return json({ BankTransactions: [{ BankTransactionID: p.split("/").pop() }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET" && !/token$/.test(h.path)); // the token refresh is auth, not a ledger write
const coding = () => hits.filter((h) => h.method === "POST" && h.path.includes("/BankTransactions/"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("the crons are the three keyed in workflow.json, and every cron entry resolves", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
  assert.equal(WF.id, "professional-services:add-bas");
});

test("pull-period reads the period and its tax rates, and never writes to Xero", async () => {
  const store = new MemoryStore();
  const r = await pullPeriod(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(r, { transactions: 4, uncoded: 3 });
  assert.equal(writes().length, 0, "reads only");
  const q = hits.find((h) => h.path.endsWith("/BankTransactions"))!.search;
  assert.equal(new URLSearchParams(q).get("where"), 'Status=="AUTHORISED" AND Date>=DateTime(2026,10,01)');
  const snap = await store.get<any>("bas", "2026-10-01");
  assert.equal(snap.lines.length, 4);
  assert.equal(snap.lines.find((l: any) => l.id === C).line_count, 2);
});

test("code-lines queues only the single-line rule match, once, and posts nothing until approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pullPeriod(ctx);
  assert.deepEqual(await codeLines(ctx), { queued: 1 });
  assert.equal(coding().length, 0, "no Xero write from the cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].acts[0].op, "accounting.updateBankTransaction");
  await codeLines(ctx); await pullPeriod(ctx); await codeLines(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "re-runs never queue twice");
});

test("approval sends the exact coding change: same amount, same contact, the rule's account and tax type", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pullPeriod(ctx); await codeLines(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "accountant", NOW);
  assert.equal(done.status, "done");
  const [call] = coding();
  assert.ok(call.path.endsWith(`/BankTransactions/${A}`), call.path);
  const tx = call.body.BankTransactions[0];
  assert.equal(tx.BankTransactionID, A);
  assert.equal(tx.Type, "SPEND");
  assert.equal(tx.LineAmountTypes, "Inclusive");
  assert.deepEqual(tx.Contact, { ContactID: CONTACT });
  assert.deepEqual(tx.LineItems, [{ Description: "Telstra mobile plan", LineAmount: -110, AccountCode: "408", TaxType: "INPUT" }]);
  await assert.rejects(approve(WF, store, ap.id, "accountant", NOW), /already done/);
  assert.equal(coding().length, 1, "approved once");
});

test("exceptions lists the lines an accountant must check, and writes nothing to Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pullPeriod(ctx);
  assert.deepEqual(await exceptions(ctx), { exceptions: 2 });
  assert.equal(writes().length, 0);
  const list = (await store.get<any>("bas-exceptions", "2026-10-01")).items as { id: string; reason: string }[];
  assert.deepEqual(list.map((x) => x.id).sort(), [B, C].sort());
  const b = list.find((x) => x.id === B)!;
  assert.match(b.reason, /no coding rule matches/);
  assert.match(b.reason, /no source document attached/);
  assert.match(list.find((x) => x.id === C)!.reason, /more than one line/);
});

test("a rule whose tax type is not active in Xero queues nothing", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, { ...SETTINGS, coding_rules: [{ match: "telstra", account_code: "408", tax_type: "OLDTAX" }] }, store, NOW, () => {});
  await pullPeriod(ctx);
  assert.deepEqual(await codeLines(ctx), { queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("guards: a period that is not a real date stops before any call; a bad rule is refused; live and draft ops stay apart", async () => {
  await assert.rejects(pullPeriod(context(WF, { ...SETTINGS, period_start: "2026-02-30" }, new MemoryStore(), NOW, () => {})), /not a real date/);
  await assert.rejects(pullPeriod(context(WF, { ...SETTINGS, period_start: "2026-10-01'); DROP" }, new MemoryStore(), NOW, () => {})), /YYYY-MM-DD/);
  assert.equal(hits.length, 0, "nothing reached the network");
  const badCtx = context(WF, { ...SETTINGS, coding_rules: [{ match: "x", account_code: "4 08", tax_type: "INPUT" }] }, new MemoryStore(), NOW, () => {});
  await pullPeriod(badCtx);
  await assert.rejects(codeLines(badCtx), /account_code/);
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateBankTransaction", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.getBankTransactions", summary: "x" }), /not a live operation/);
});
