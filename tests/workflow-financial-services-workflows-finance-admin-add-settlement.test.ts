// Settlement tracker tests. Every request goes to a fake network: the crons must make none at all.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS, checklist, overdue } from "../industries/financial-services/workflows/finance-admin/add-settlement/index.ts";
import type { Checklist, Settlement } from "../industries/financial-services/workflows/finance-admin/add-settlement/types.ts";

const DIR = "industries/financial-services/workflows/finance-admin/add-settlement";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Broking", overdue_after_days: 1 };
const NOW = new Date("2026-11-09T00:00:00Z");
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any) => { calls.push(String(url)); throw new Error("network is not allowed in these tests"); }) as any,
  });
});

const rec = (over: Partial<Settlement> & { id: string }): Settlement => ({
  borrower: "A Borrower", lender: "Example Bank", lender_confirmed: true, file_notes: 1, post_settlement_checks: false, ...over,
});

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const rows: Settlement[] = [
    rec({ id: "file-1", settlement_date: "2026-11-20", file_notes: 2 }),                                  // ready, date ahead
    rec({ id: "file-2", lender_confirmed: false, file_notes: 0 }),                                       // no date, no confirmation, no note
    rec({ id: "file-3", settlement_date: "2026-11-01" }),                                                // past date, checks open
    rec({ id: "file-4", settlement_date: "2026-11-01", post_settlement_checks: true }),                   // past date, checks done
    rec({ id: "../escape" }),                                                                            // bad id
    rec({ id: "file-6", settlement_date: "2026-13-45" }),                                                // bad date
  ];
  rows.forEach((r, i) => store.put("settlements", `row-${i}`, r));
  return store;
}

test("the crons are the two in the record, and neither can run or queue a platform operation", async () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.deepEqual(WF.draft_ops, {});
  assert.deepEqual(WF.live_ops, {});
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.getItems", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.updateQuote", summary: "x" }), /not a live operation/);
});

test("crons never reach the network", async () => {
  const store = await seeded();
  await checklist(context(WF, S, store, NOW, () => {}));
  await overdue(context(WF, S, store, NOW, () => {}));
  assert.equal(calls.length, 0);
});

test("one checklist per valid settlement; invalid records are skipped; re-runs overwrite and never add", async () => {
  const store = await seeded();
  const once = await checklist(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(once, { written: 4, skipped: 2 });
  const again = await checklist(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(again, { written: 4, skipped: 2 });
  const all = await store.list<Checklist>("checklists");
  assert.deepEqual(Object.keys(all).sort(), ["file-1", "file-2", "file-3", "file-4"]);
  assert.equal(all["file-1"].status, "ready");
  assert.deepEqual(all["file-2"].missing, ["settlement date", "lender confirmation", "file note"]);
  assert.equal(all["file-2"].status, "missing-items");
  assert.deepEqual(all["file-3"].missing, ["post-settlement checks"]);
  assert.equal(all["file-3"].status, "overdue");
  assert.equal(all["file-4"].status, "ready");
});

test("overdue lists only settlements past their date with checks open, as one internal record", async () => {
  const store = await seeded();
  await checklist(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await overdue(context(WF, S, store, NOW, () => {})), { overdue: 1 });
  await overdue(context(WF, S, store, NOW, () => {}));
  const latest = await store.get<{ settlements: string[] }>("overdue", "latest");
  assert.deepEqual(latest!.settlements, ["file-3"]);
  assert.equal(calls.length, 0);
});

test("an approval naming an operation this workflow does not allow live is refused before any call", async () => {
  const store = new MemoryStore();
  await store.put("approvals", "fake-approval", {
    id: "fake-approval", workflow: WF.id, summary: "x", status: "pending", created: NOW.toISOString(),
    acts: [{ platform: "xero", op: "accounting.updateQuote", input: {}, summary: "x" }],
  } satisfies Approval);
  await assert.rejects(approve(WF, store, "fake-approval", "owner", NOW), /not a live operation/);
  assert.equal(calls.length, 0);
});
