// Tabs and room charges workflow tests. No request reaches a real account: draft operations are stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { folioConfig, reconcile, CRONS } from "../industries/hospitality/workflows/finance-admin/tabs-room-charges/index.ts";
import type { Settings } from "../industries/hospitality/workflows/finance-admin/tabs-room-charges/types.ts";

const DIR = "industries/hospitality/workflows/finance-admin/tabs-room-charges";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const OPS = JSON.parse(fs.readFileSync("core/sdk/platforms/cloudbeds/ops.json", "utf8")) as { id: string; kind: string }[];
const SETTINGS: Settings = { property_id: 4242, business_name: "Example Hotel", timezone: "Australia/Sydney" };
const NOON_UTC = new Date("2026-11-09T13:00:00Z");

/** A context whose draft calls are stubbed: it enforces the draft allowlist and records what ran. */
function harness(settings: Settings = SETTINGS) {
  const store = new MemoryStore();
  const ctx = context(WF, settings, store, NOON_UTC, () => {});
  const drafts: { op: string; input: any }[] = [];
  ctx.draft = (async (a: any) => {
    if (!(WF.draft_ops[a.platform] ?? []).includes(a.op)) throw new Error(`not a draft op: ${a.op}`);
    drafts.push({ op: a.op, input: a.input });
    return { status: 200, headers: new Headers(), data: { ok: true, op: a.op } };
  }) as any;
  return { ctx, store, drafts };
}

test("the crons match the workflow record", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("every draft operation is a read", () => {
  const kinds = new Map(OPS.map((o) => [o.id, o.kind]));
  for (const op of WF.draft_ops.cloudbeds) assert.equal(kinds.get(op), "read", `${op} must be a read`);
});

test("crons only reach draft operations and never send", async () => {
  const { ctx, drafts } = harness();
  await folioConfig(ctx);
  await reconcile(ctx);
  assert.deepEqual(drafts.map((d) => d.op).sort(), [...WF.draft_ops.cloudbeds].sort());
  for (const d of drafts) assert.ok(!WF.live_ops.cloudbeds.includes(d.op));
});

test("a live operation can never run as a draft", async () => {
  const { ctx } = harness();
  await assert.rejects(ctx.draft({ platform: "cloudbeds", op: "accounting-v1-0-openapi.moveTransactions", summary: "move" }), /not a draft op/);
});

test("a live operation is only queued, and a re-run never queues it twice", async () => {
  const { ctx, store } = harness();
  const act = { platform: "cloudbeds", op: "accounting-v1-0-openapi.moveTransactions", summary: "move a tab charge", key: "tab-1" };
  const first = await ctx.queue(act);
  const again = await ctx.queue(act);
  assert.equal(first, again);
  const approvals = await store.list<{ status: string }>("approvals");
  assert.equal(Object.keys(approvals).length, 1);
  assert.equal(Object.values(approvals)[0].status, "pending");
});

test("a read operation cannot be queued", async () => {
  const { ctx } = harness();
  await assert.rejects(ctx.queue({ platform: "cloudbeds", op: "accounting-v1-0-openapi.getTrialBalanceReport", summary: "read" }), /not a live operation/);
});

test("folio config is stored once per property", async () => {
  const { ctx, store } = harness();
  await folioConfig(ctx);
  const stored = await store.get<{ at: string }>("folio-config", "4242");
  assert.equal(stored?.at, NOON_UTC.toISOString());
});

test("a nightly reconcile for the same day stores one record", async () => {
  const { ctx, store } = harness();
  await reconcile(ctx);
  await reconcile(ctx);
  assert.equal(Object.keys(await store.list("trial-balance")).length, 1);
  assert.ok(await store.get("trial-balance", "4242-2026-11-09"));
});

test("a bad property number is refused before any request", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const { ctx, drafts } = harness({ ...SETTINGS, property_id: bad });
    await assert.rejects(folioConfig(ctx), /positive whole number/);
    assert.equal(drafts.length, 0);
  }
});
