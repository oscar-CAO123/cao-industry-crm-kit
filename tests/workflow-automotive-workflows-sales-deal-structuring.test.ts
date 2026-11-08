// Automotive deal-structuring workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp, CRONS } from "../industries/automotive/workflows/sales/deal-structuring/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/automotive/workflows/sales/deal-structuring/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let drafts = 0;

function fake() {
  hits = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Pipedrive
      if (p.endsWith("/deals") && m === "GET") return json({ success: true, data: [
        { id: 101, title: "2024 Ford Ranger <img src=x> - Sam Lee", value: 45000, currency: "AUD", stage_id: 2, person_id: 7 }], additional_data: { next_cursor: null } });
      if (p.endsWith("/deals/101") && m === "PATCH") return json({ success: true, data: { id: 101, stage_id: 3 } });
      if (p.endsWith("/notes") && m === "POST") return json({ success: true, data: { id: 1 } });
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const stageMoves = () => hits.filter((h) => h.method === "PATCH" && h.path.endsWith("/deals/101"));

const SETTINGS: any = {
  business_name: "Test Motors",
  pipedrive: { pipeline_id: 1, intake_stage_id: 2, submitted_stage_id: 3 },
  microsoft_365: { mailbox: "finance@example.com.au", register: { drive: "D1", item: "I1", table: "Deals" } },
  lenders: [{ id: "lender-a", name: "Lender A", submit_to: "deals@lender-a.example.com" }, { id: "lender-b", name: "Lender B", submit_to: "deals@lender-b.example.com" }],
  max_lenders_per_deal: 3,
  follow_up: { after_days: [3, 7] },
};
const PROP = { lenders: ["lender-a", "lender-b"], credit_ready: true, amount_financed: 38000, term_months: 60 };
const NOW = new Date("2026-11-09T00:00:00Z");
const FOUR_DAYS = new Date("2026-11-13T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PIPEDRIVE_API_TOKEN: "pd", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons are keyed by their entry names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["draft", "follow-up", "intake"]);
  assert.equal(WF.id, "automotive:deal-structuring");
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "pipedrive", op: "openapi-v2.updateDeal", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "pipedrive", op: "docs_api_v1.addNote", summary: "x" }), /not a live operation/);
});

test("crons never send and never move a deal; a credit-ready deal gets one queued send per lender", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.equal((await intake(ctx) as any).added, 1);
  await store.put("proposals", "101", PROP);
  await draft(ctx);
  assert.equal(sends().length, 0, "no send reached the network");
  assert.equal(stageMoves().length, 0, "no deal was moved");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 2);
  assert.ok(aps.every((a) => a.status === "pending"));
  const a = aps.find((x) => x.acts[0].input?.params?.["user-id"] === "finance@example.com.au" && x.summary.includes("Lender A"));
  assert.ok(a, "lender A approval queued");
  assert.deepEqual(a!.acts.map((x) => x.op), ["users.user.messages.message.send", "openapi-v2.updateDeal"]);
});

test("the Outlook draft escapes the deal title", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "101", PROP);
  await draft(ctx);
  const created = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
  assert.equal(created.length, 2);
  for (const h of created) {
    assert.ok(!String(h.body.body.content).includes("<img"), "raw tag must not reach the email body");
    assert.ok(String(h.body.body.content).includes("&lt;img"));
  }
});

test("approval runs the send, then moves the deal to the lender-submitted stage", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "101", PROP);
  await draft(ctx);
  const id = approvalId(WF.id, "submit:101:lender-a");
  const done = await approve(WF, store, id, "oscar", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(stageMoves().length, 1);
  assert.deepEqual(stageMoves()[0].body, { stage_id: 3 });
});

test("a re-run never drafts or queues the same lender pack twice", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "101", PROP);
  await draft(ctx);
  await intake(ctx);
  await draft(ctx);
  assert.equal(drafts, 2, "one Outlook draft per lender, no more");
  assert.equal(Object.keys(await store.list("approvals")).length, 2);
});

test("a deal without a credit-ready proposal is left alone", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("proposals", "101", { ...PROP, credit_ready: false });
  await draft(ctx);
  assert.equal(drafts, 0);
  assert.equal((await store.get<any>("deals", "101")).status, "new");
});

test("follow-up marks a deal submitted once its send is done, then chases after the set days", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await store.put("proposals", "101", PROP);
  await draft(context(WF, SETTINGS, store, NOW, () => {}));
  await approve(WF, store, approvalId(WF.id, "submit:101:lender-a"), "oscar", NOW);

  await followUp(context(WF, SETTINGS, store, NOW, () => {}));
  const deal = await store.get<any>("deals", "101");
  assert.equal(deal.status, "submitted");
  assert.equal(deal.submitted_to, "lender-a");
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "no chase before the first day count");

  await followUp(context(WF, SETTINGS, store, FOUR_DAYS, () => {}));
  assert.equal(Object.keys(await store.list("approvals")).length, 3, "one chase queued after three days");
  assert.equal(sends().length, 1, "the chase is queued, not sent");
  assert.equal((await store.get<any>("deals", "101")).followups.length, 1);

  await followUp(context(WF, SETTINGS, store, FOUR_DAYS, () => {}));
  assert.equal(Object.keys(await store.list("approvals")).length, 3, "a second run does not chase again");
});
