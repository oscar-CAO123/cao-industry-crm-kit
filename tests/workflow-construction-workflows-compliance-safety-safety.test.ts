// Safety paperwork workflow tests. Every request goes to a fake network: no test reaches a real SiteBook account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { prestart, swmsReview, reminders, CRONS } from "../industries/construction/workflows/compliance-safety/safety/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/compliance-safety/safety/workflow.json", "utf8")) as WorkflowRecord;
const TPL = "11111111-1111-4111-8111-111111111111", SWMS = "22222222-2222-4222-8222-222222222222", JOB = "33333333-3333-4333-8333-333333333333";
const ASSET = "77777777-7777-4777-8777-777777777777";
const CHK = "44444444-4444-4444-8444-444444444444", ACT = "55555555-5555-4555-8555-555555555555", MAILTPL = "66666666-6666-4666-8666-666666666666";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { business_name: "Test Civil", prestart: { template_checklist_id: TPL, swms_id: SWMS, job_title_prefix: "Pre-start: ", asset_id: ASSET },
  swms_review_days: 90, reminder_days: 2, reminder_template_id: MAILTPL };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let swmsReviewed = "2026-06-01T00:00:00Z"; // more than 90 days before NOW

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v1/jobs") return json({ jobs: [{ JobId: JOB, Title: "Level 3 fit-out" }, { JobId: "not-a-guid", Title: "bad id" }] });
      if (p === "/v1/checklists" && m === "POST") return json({ checkLists: [{ CheckListId: CHK, Title: body.Title }] });
      if (p === `/v1/checklists/${CHK}/swms`) return json([{ CheckListId: CHK, SwmsId: SWMS }]);
      if (p === "/v1/swms") return json({ swms: [{ SwmsId: SWMS, Title: "Working at heights", ReviewedOn: swmsReviewed }] });
      if (p === "/v1/actions" && m === "POST") return json({ ActionId: body.ActionId });
      if (p === "/v2/actions") return json({ actions: [
        { ActionId: ACT, ActionRequired: "Fix guard rail", DueDate: "2026-11-10T00:00:00Z", Active: true },
        { ActionId: "66666666-7777-4777-8777-777777777777", ActionRequired: "Far off", DueDate: "2027-01-01T00:00:00Z", Active: true }] });
      if (p === `/v1/actions/${ACT}/email`) return json({});
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const emails = () => hits.filter((h) => h.path.endsWith("/email"));

beforeEach(() => {
  fake();
  swmsReviewed = "2026-06-01T00:00:00Z";
  process.env.SITEBOOK_API_KEY = "test-key";
  process.env.KIT_ALLOW_WRITES = "1";
});

test("every mapped operation exists in the SiteBook ops file", () => {
  const ops = new Set((JSON.parse(fs.readFileSync("core/sdk/platforms/sitebook/ops.json", "utf8")) as { id: string }[]).map((o) => o.id));
  for (const op of [...WF.draft_ops.sitebook, ...WF.live_ops.sitebook]) assert.ok(ops.has(op), `${op} is not in ops.json`);
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `cron ${c.entry} is exported`);
});

test("a cron cannot run a live operation, and cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "sitebook", op: "docs.post_v1_actions_actionId_email", input: { params: { actionId: ACT } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "sitebook", op: "docs.post_v1_actions", summary: "x" }), /not a live operation/);
});

test("pre-start: one checklist per job with the SWMS attached, and nothing repeated on a re-run", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await prestart(ctx), { created: 1, attached: 1 });
  const create = hits.find((h) => h.path === "/v1/checklists" && h.method === "POST")!.body;
  assert.deepEqual(create, { CheckListId: TPL, JobId: JOB, Title: "Pre-start: Level 3 fit-out", AssetId: ASSET });
  assert.deepEqual(hits.find((h) => h.path.endsWith("/swms"))!.body, { SwmsId: SWMS });
  hits = [];
  assert.deepEqual(await prestart(ctx), { created: 0, attached: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "a re-run writes nothing");
});

test("SWMS review: one review action when the last review is old, none for a fresh review", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await swmsReview(ctx), { raised: 1 });
  const act = hits.find((h) => h.path === "/v1/actions" && h.method === "POST")!.body;
  assert.match(act.ActionId, UUID);
  assert.equal(act.ActionRequired, "Review SWMS: Working at heights");
  hits = [];
  assert.deepEqual(await swmsReview(ctx), { raised: 0 }, "inside the window, no second action");
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
  swmsReviewed = "2026-11-01T00:00:00Z";
  assert.deepEqual(await swmsReview(context(WF, S, new MemoryStore(), NOW, () => {})), { raised: 0 }, "a recent review is left alone");
});

test("reminders: queued for approval, never sent by the cron, and approval sends once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await reminders(ctx), { due_soon: 1 });
  assert.equal(emails().length, 0, "nothing sent by a cron");
  await reminders(ctx);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1, "a re-run never queues the same action twice");
  const ap = await approve(WF, store, aps[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(emails()[0].body, { EmailTemplateId: MAILTPL });
  assert.equal(emails()[0].path, `/v1/actions/${ACT}/email`);
  await assert.rejects(approve(WF, store, aps[0].id, "owner", NOW), /already done/);
});

test("pre-start: no checklist is made until an asset is set, and the set asset goes on the create", async () => {
  const store = new MemoryStore();
  const noAsset: any = { ...S, prestart: { ...S.prestart, asset_id: undefined } };
  assert.deepEqual(await prestart(context(WF, noAsset, store, NOW, () => {})), { created: 0, attached: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "nothing sent without an asset");
  assert.deepEqual(await prestart(context(WF, S, store, NOW, () => {})), { created: 1, attached: 1 });
  assert.equal(hits.find((h) => h.path === "/v1/checklists" && h.method === "POST")!.body.AssetId, ASSET);
});

test("pre-start: a create that returns no checklist id is held, and the next run makes no second checklist", async () => {
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v1/jobs") return json({ jobs: [{ JobId: JOB, Title: "Level 3 fit-out" }] });
      if (p === "/v1/checklists" && m === "POST") return json({ checkLists: [] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
  const store = new MemoryStore();
  await assert.rejects(prestart(context(WF, S, store, NOW, () => {})), /bad id/);
  hits = [];
  assert.deepEqual(await prestart(context(WF, S, store, NOW, () => {})), { created: 0, attached: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "the held job is not created again");
});

test("pre-start: a template id that is not a SiteBook id is refused before any job is marked", async () => {
  const store = new MemoryStore();
  const bad: any = { ...S, prestart: { ...S.prestart, template_checklist_id: "not-a-guid" } };
  assert.deepEqual(await prestart(context(WF, bad, store, NOW, () => {})), { created: 0, attached: 0 });
  assert.equal(hits.length, 0);
  assert.equal(Object.keys(await store.list("prestart")).length, 0);
});
