// Refund and chargeback workflow tests. Every request goes to a fake network: no test reaches a real Square account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { watch, refunds, respond } from "../industries/retail/workflows/finance-admin/disputes/index.ts";

const DIR = "industries/retail/workflows/finance-admin/disputes";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { business_name: "Test Store", lookback_days: 30, flag_within_days: 3 };

const OPEN = { id: "DSP_1001", state: "EVIDENCE_REQUIRED", reason: "NOT_RECEIVED", amount_money: { amount: 12500, currency: "AUD" },
               due_at: "2026-11-11T00:00:00Z", disputed_payment: { payment_id: "PAY_77" }, evidence_ids: [] };
const WON = { id: "DSP_0900", state: "WON", reason: "DUPLICATE", amount_money: { amount: 3000, currency: "AUD" }, evidence_ids: [] };
const REFUND = { id: "REF_500", status: "APPROVED", payment_id: "PAY_12", amount_money: { amount: 4000, currency: "AUD" },
                 reason: "Changed mind", created_at: "2026-11-08T03:00:00Z" };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let evidenceSeq = 0;

function fake() {
  hits = []; evidenceSeq = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v2/disputes" && m === "GET") return json({ disputes: [OPEN, WON] });
      if (p === "/v2/refunds" && m === "GET") return json({ refunds: [REFUND] });
      if (/^\/v2\/disputes\/[^/]+\/evidence-text$/.test(p) && m === "POST") return json({ evidence: { id: `EVD_${++evidenceSeq}`, evidence_type: body?.evidence_type } });
      if (p === "/v2/refunds" && m === "POST") return json({ refund: { id: "REF_9", status: "PENDING" } });
      if (/^\/v2\/disputes\/[^/]+\/submit-evidence$/.test(p) && m === "POST") return json({ dispute: { id: "DSP_1001", state: "PROCESSING" } });
      if (/^\/v2\/disputes\/[^/]+\/accept$/.test(p) && m === "POST") return json({ dispute: { id: "DSP_1001", state: "ACCEPTED" } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
/** Requests that move money or change what the bank sees: refund, submit evidence, accept. */
const moneyMoves = () => hits.filter((h) => h.method === "POST" && (h.path === "/v2/refunds" || /submit-evidence$|\/accept$/.test(h.path)));

beforeEach(() => {
  fake();
  Object.assign(process.env, { SQUARE_ACCESS_TOKEN: "sq-test-token", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "square", op: "api.SubmitEvidence", summary: "x", input: { params: { dispute_id: "DSP_1001" } } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "square", op: "api.ListDisputes", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("watch: records disputes and refunds, stages a written evidence note once, and moves no money", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("evidence", "DSP_1001", { evidence_type: "PROOF_OF_DELIVERY_DOCUMENTATION", text: "Tracked parcel delivered 3 Nov, signed by the customer.", written_by: "owner" });
  const first = await watch(ctx) as any;
  assert.equal(first.disputes, 2);
  assert.equal(first.refunds, 1);
  assert.equal(first.staged, 1);
  const d = await store.get<any>("disputes", "DSP_1001");
  assert.deepEqual(d.staged, ["PROOF_OF_DELIVERY_DOCUMENTATION"]);
  assert.equal(d.amount.cents, 12500);
  const staged = hits.find((h) => h.path.endsWith("/evidence-text"))!;
  assert.equal(staged.body.evidence_type, "PROOF_OF_DELIVERY_DOCUMENTATION");
  assert.ok(staged.body.idempotency_key.length <= 45);
  assert.equal(moneyMoves().length, 0, "nothing refunded, submitted or accepted");
  assert.equal((await store.get<any>("refunds", "REF_500")).amount.cents, 4000);
  const again = await watch(ctx) as any;
  assert.equal(again.staged, 0, "re-runs never stage twice");
  assert.equal(hits.filter((h) => h.path.endsWith("/evidence-text")).length, 1);
});

test("watch: an evidence note over 500 characters is not staged and is counted as failed", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("evidence", "DSP_1001", { evidence_type: "GENERIC_EVIDENCE", text: "x".repeat(501), written_by: "owner" });
  const out = await watch(ctx) as any;
  assert.equal(out.staged, 0);
  assert.equal(out.stage_failed, 1);
  assert.equal(hits.filter((h) => h.path.endsWith("/evidence-text")).length, 0);
});

test("refunds: a decided refund is queued once and runs only on approval; a decline is never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("refund_decisions", "REQ-1", { platform: "square", payment_id: "PAY_12", amount_cents: 4000, reason: "Changed mind", decision: "refund", decided_by: "owner" });
  await store.put("refund_decisions", "REQ-2", { platform: "square", payment_id: "PAY_13", amount_cents: 900, decision: "decline", decided_by: "owner" });
  assert.deepEqual(await refunds(ctx), { queued: 1, declined: 1, invalid: 0 });
  assert.equal(moneyMoves().length, 0, "queued, not run");
  assert.deepEqual(await refunds(ctx), { queued: 0, declined: 1, invalid: 0 }, "re-runs never queue twice");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["api.RefundPayment"]);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const refund = hits.find((h) => h.method === "POST" && h.path === "/v2/refunds")!;
  assert.equal(refund.body.payment_id, "PAY_12");
  assert.deepEqual(refund.body.amount_money, { amount: 4000, currency: "AUD" });
  assert.equal(refund.body.reason, "Changed mind");
  assert.ok(refund.body.idempotency_key.length <= 45);
  assert.equal(done.results!.at(-1)!.ref!.id, "REF_9");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(moneyMoves().length, 1, "refunded once");
});

test("refunds: a decision with a bad payment id or amount is refused before any request", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("refund_decisions", "REQ-3", { platform: "square", payment_id: "PAY_1/../../x", amount_cents: 500, decision: "refund", decided_by: "owner" });
  await store.put("refund_decisions", "REQ-4", { platform: "square", payment_id: "PAY_14", amount_cents: -5, decision: "refund", decided_by: "owner" });
  assert.deepEqual(await refunds(ctx), { queued: 0, declined: 0, invalid: 2 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal(hits.length, 0);
});

test("respond: a submit is queued once staged evidence exists, and runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("evidence", "DSP_1001", { evidence_type: "PROOF_OF_DELIVERY_DOCUMENTATION", text: "Tracked parcel delivered 3 Nov.", written_by: "owner" });
  await watch(ctx);
  await store.put("dispute_decisions", "DSP_1001", { decision: "submit", decided_by: "owner" });
  assert.deepEqual(await respond(ctx), { queued: 1, invalid: 0, flagged: 0, held: 0 });
  assert.equal(moneyMoves().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["api.SubmitEvidence"]);
  await approve(WF, store, ap.id, "owner", NOW);
  assert.ok(hits.some((h) => h.method === "POST" && h.path === "/v2/disputes/DSP_1001/submit-evidence"));
  assert.deepEqual(await respond(ctx), { queued: 0, invalid: 0, flagged: 0, held: 0 }, "re-runs never queue twice");
});

test("respond: a submit with no evidence staged is held, never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await watch(ctx);
  await store.put("dispute_decisions", "DSP_1001", { decision: "submit", decided_by: "owner" });
  assert.deepEqual(await respond(ctx), { queued: 0, invalid: 0, flagged: 0, held: 1 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("respond: an accept is queued and runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await watch(ctx);
  await store.put("dispute_decisions", "DSP_1001", { decision: "accept", decided_by: "owner" });
  assert.deepEqual(await respond(ctx), { queued: 1, invalid: 0, flagged: 0, held: 0 });
  assert.equal(moneyMoves().length, 0, "queued, not accepted");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["api.AcceptDispute"]);
  await approve(WF, store, ap.id, "owner", NOW);
  assert.ok(hits.some((h) => h.method === "POST" && h.path === "/v2/disputes/DSP_1001/accept"));
});

test("respond: an open dispute near its deadline with no decision is flagged; a closed one is not", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await watch(ctx);
  // DSP_1001 is due 11 Nov, two days after NOW, inside the three-day flag window. DSP_0900 is WON and never flagged.
  assert.deepEqual(await respond(ctx), { queued: 0, invalid: 0, flagged: 1, held: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});
