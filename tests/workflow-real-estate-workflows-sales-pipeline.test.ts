// Pipeline workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { pipelineSync, prospectReview, CRONS } from "../industries/real-estate/workflows/sales/pipeline/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/pipeline/workflow.json", "utf8")) as WorkflowRecord;
const C1 = { id: "OXF18000001", forename: "John", surname: "Smith", email: "john@example.com", mobilePhone: "07890 123456", modified: "2026-11-01T10:00:00Z" };
const C2 = { id: "OXF18000002", forename: "Ana", surname: "Lee", email: "ana@example.com", modified: "2026-11-02T10:00:00Z" };
const BAD = { id: "../../etc", forename: "Bad" };
const SETTINGS: any = { business_name: "Test Agency", stale_after_days: 7 };
const NOW = new Date("2026-11-09T21:00:00Z");

type Hit = { method: string; path: string };
let hits: Hit[] = [];
let contactsBody: unknown[] = [];
let detailCalls = 0;

function fake() {
  hits = []; detailCalls = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/contacts" && m === "GET") return json({ pageSize: 25, pageNumber: 1, pageCount: contactsBody.length, totalPageCount: 1, _embedded: contactsBody });
      const d = p.match(/^\/contact\/([^/]+)$/);
      if (d && m === "GET") { detailCalls++; const c = [C1, C2].find((x) => x.id === d[1]); return c ? json(c) : json({}, 404); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  contactsBody = [C1, C2, BAD];
  process.env.REAPIT_ACCESS_TOKEN = "test-token";
});

test("every draft operation is a read, and the workflow has no live operations", () => {
  for (const [platform, ops] of Object.entries(WF.draft_ops)) for (const op of ops) assert.equal(describeOp(platform, op).kind, "read", op);
  assert.deepEqual(WF.live_ops, {}, "nothing is queued for approval");
});

test("every cron in workflow.json has an entry in index.ts", () => {
  for (const c of WF.crons) assert.equal(typeof (CRONS as any)[c.entry], "function", c.entry);
});

test("a cron cannot draft a write or queue anything", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "agentbox", op: "post:/documents", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "agentbox", op: "get:/contacts", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "no request was made");
});

test("pipeline-sync reads the first page, tracks new prospects, and drops a contact id that is not valid", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await pipelineSync(ctx), { seen: 2, added: 2, updated: 0 });
  assert.equal(writes().length, 0, "no write from the read cron");
  assert.equal(detailCalls, 0, "the list alone is enough for pipeline-sync");
  assert.deepEqual(Object.keys(await store.list("prospects")).sort(), [C1.id, C2.id]);
  const p = await store.get<any>("prospects", C1.id);
  assert.equal(p.name, "John Smith");
  assert.equal(p.email, "john@example.com");
  assert.equal(p.stage, "untracked");
});

test("pipeline-sync adds nothing on a re-run with the same contacts", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pipelineSync(ctx);
  assert.deepEqual(await pipelineSync(ctx), { seen: 2, added: 0, updated: 0 });
  assert.equal(Object.keys(await store.list("prospects")).length, 2);
});

test("pipeline-sync refreshes a contact whose modified stamp changed, and keeps its stage", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pipelineSync(ctx);
  await store.put("prospects", C1.id, { ...(await store.get<any>("prospects", C1.id)), stage: "contacted" });
  contactsBody = [{ ...C1, email: "new@example.com", modified: "2026-11-05T10:00:00Z" }, C2];
  assert.deepEqual(await pipelineSync(ctx), { seen: 2, added: 0, updated: 1 });
  const p = await store.get<any>("prospects", C1.id);
  assert.equal(p.email, "new@example.com");
  assert.equal(p.stage, "contacted", "a changed contact keeps the stage the agent set");
});

test("prospect-review reads each new prospect's detail once and lists the ones due for follow-up", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pipelineSync(ctx);
  assert.deepEqual(await prospectReview(ctx), { detailed: 2, untracked: 2, due: 0 });
  assert.equal(detailCalls, 2);
  assert.equal(writes().length, 0, "no write from the review cron");

  assert.deepEqual(await prospectReview(ctx), { detailed: 0, untracked: 2, due: 0 });
  assert.equal(detailCalls, 2, "a re-run reads no detail again");

  const later = context(WF, SETTINGS, store, new Date("2026-11-20T21:00:00Z"), () => {});
  assert.deepEqual(await prospectReview(later), { detailed: 0, untracked: 2, due: 2 });
  const rev = await store.get<any>("reviews", "latest");
  assert.deepEqual(rev.due_for_follow_up, [C1.id, C2.id]);
});

test("a prospect the agent has staged is not listed for follow-up", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pipelineSync(ctx);
  await store.put("prospects", C2.id, { ...(await store.get<any>("prospects", C2.id)), stage: "appraisal booked" });
  const later = context(WF, SETTINGS, store, new Date("2026-11-20T21:00:00Z"), () => {});
  assert.deepEqual(await prospectReview(later), { detailed: 1, untracked: 1, due: 1 }, "only the untracked prospect is read");
  assert.equal(detailCalls, 1);
  assert.deepEqual((await store.get<any>("reviews", "latest")).due_for_follow_up, [C1.id]);
});
