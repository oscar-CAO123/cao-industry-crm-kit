// Lead follow-up workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, chase } from "../industries/all/workflows/sales/lead-followup/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/lead-followup/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const DAYS = (n: number) => new Date(NOW.getTime() + n * 864e5);

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let opps: Record<string, any[]> = {};   // GoHighLevel opportunities by pipeline stage
let deals: Record<string, any[]> = {};  // Pipedrive deals by stage

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // GoHighLevel
      if (p === "/opportunities/search") return json({ opportunities: opps[u.searchParams.get("pipelineStageId") ?? ""] ?? [], meta: {} });
      if (/^\/contacts\/[^/]+\/(tasks|notes)$/.test(p) && m === "POST") return json({ id: "t1" });
      if (p === "/conversations/messages" && m === "POST") return json({ messageId: "m1", conversationId: "c1", status: "pending" });
      if (/^\/opportunities\/[^/]+\/status$/.test(p) && m === "PUT") return json({ id: "o1" });
      // Pipedrive
      if (/^\/v1\/pipelines\/[^/]+\/deals$/.test(p)) return json({ success: true, data: deals[u.searchParams.get("stage_id") ?? ""] ?? [] });
      if (p === "/api/v2/activities" || p === "/v1/notes") return json({ success: true, data: { id: 1 } });
      if (/^\/api\/v2\/deals\/[^/]+$/.test(p) && m === "PATCH") return json({ success: true, data: { id: 101 } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const GHL: any = {
  crm: "gohighlevel", business_name: "Test Co", pipeline_id: "PIPE1", location_id: "LOC1",
  watch: [{ stage_id: "NEW1", role: "lead" }, { stage_id: "QUO1", role: "quote" }],
  channel: "sms", follow_up: { after_days: [3, 7] }, lost_after_days: 14, lost_reason_id: "LOSTREASON1",
  templates: { first_touch: "Hi, thanks for getting in touch with {business_name} about {title}.", quote_first: "Hi, following up our quote for {title}.",
    follow_up: ["Checking in on {title}.", "Last check on {title}."] },
};
const PD: any = { ...GHL, crm: "pipedrive", location_id: undefined, lost_reason_id: undefined, lost_reason: "No reply after follow-ups" };

const opp = (id: string, stage: string, contact: string | null = `c${id}`) => ({
  id, name: `Lead ${id}`, pipelineStageId: stage, status: "open", ...(contact ? { contactId: contact } : {}),
});
const ctxFor = (s: any, store: MemoryStore, now = NOW) => context(WF, s, store, now, () => {});
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const sendHits = () => hits.filter((h) => h.path === "/conversations/messages");
const stageHits = () => hits.filter((h) => /^\/opportunities\/[^/]+\/status$/.test(h.path) || /^\/api\/v2\/deals\/[^/]+$/.test(h.path));

beforeEach(() => {
  fake(); opps = {}; deals = {};
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "ghl-test", PIPEDRIVE_API_TOKEN: "pd-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live send and a cron cannot queue a draft operation", async () => {
  const ctx = ctxFor(GHL, new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "conversations.send-a-new-message", summary: "x", input: { body: {} } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "contacts.create-task", key: "k", input: {} }), /not a live operation/);
  assert.equal(sendHits().length, 0);
});

test("gohighlevel: a cron drafts the first contact in the CRM and queues the send; nothing is sent", async () => {
  opps = { NEW1: [opp("OPP1", "NEW1")] };
  const store = new MemoryStore();
  await intake(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));
  assert.equal(sendHits().length, 0, "a cron never sends");
  assert.ok(hits.some((h) => h.path === "/contacts/cOPP1/tasks"), "the task is drafted in the CRM");
  const aps = await approvals(store);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  assert.equal(aps[0].acts[0].op, "conversations.send-a-new-message");
  assert.equal((await store.get<any>("leads", "gohighlevel:OPP1")).touches, 1);
});

test("re-runs never double-queue: a second draft run on the same day adds nothing", async () => {
  opps = { NEW1: [opp("OPP1", "NEW1")] };
  const store = new MemoryStore();
  await intake(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));
  assert.equal((await approvals(store)).length, 1);
  assert.equal(hits.filter((h) => h.path === "/contacts/cOPP1/tasks").length, 1);
});

test("follow-ups wait their gap, an approved send runs, and a quiet lead is queued to lost only after the last follow-up", async () => {
  opps = { NEW1: [opp("OPP1", "NEW1")] };
  const store = new MemoryStore();
  await intake(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));                  // day 0: first contact queued
  await draft(ctxFor(GHL, store, DAYS(2)));         // gap of 3 days not reached
  assert.equal((await approvals(store)).length, 1);
  await draft(ctxFor(GHL, store, DAYS(3)));         // first follow-up due
  await draft(ctxFor(GHL, store, DAYS(3)));         // and not queued twice
  assert.equal((await approvals(store)).length, 2);
  await draft(ctxFor(GHL, store, DAYS(10)));        // second follow-up due, 7 days on
  assert.equal((await approvals(store)).length, 3);
  await chase(ctxFor(GHL, store, DAYS(20)));        // 10 days quiet: not yet
  assert.equal((await approvals(store)).filter((a) => a.acts[0].op === "opportunities.update-opportunity-status").length, 0);
  await chase(ctxFor(GHL, store, DAYS(24)));        // 14 days quiet after the last touch
  const lost = (await approvals(store)).filter((a) => a.acts[0].op === "opportunities.update-opportunity-status");
  assert.equal(lost.length, 1);
  assert.equal(stageHits().length, 0, "a cron never moves a stage");

  const first = (await approvals(store)).find((a) => a.acts[0].key === "touch:gohighlevel:OPP1:0")!;
  const done = await approve(WF, store, first.id, "oscar", DAYS(24));
  assert.equal(done.status, "done");
  assert.equal(sendHits().length, 1);
  assert.equal(sendHits()[0].body.contactId, "cOPP1");
  assert.equal(sendHits()[0].body.type, "SMS");
});

test("a lead that leaves the watched stages stops getting touches", async () => {
  opps = { NEW1: [opp("OPP1", "NEW1")] };
  const store = new MemoryStore();
  await intake(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));
  opps = { NEW1: [] };                              // moved on in the CRM
  await intake(ctxFor(GHL, store, DAYS(1)));
  assert.equal((await store.get<any>("leads", "gohighlevel:OPP1")).status, "left-stage");
  await draft(ctxFor(GHL, store, DAYS(3)));
  assert.equal((await approvals(store)).length, 1, "no follow-up is queued after the lead moved");
});

test("gohighlevel: a lead with no contact is held for a person, not queued", async () => {
  opps = { NEW1: [opp("OPP2", "NEW1", null)] };
  const store = new MemoryStore();
  await intake(ctxFor(GHL, store));
  await draft(ctxFor(GHL, store));
  assert.equal(sendHits().length, 0);
  assert.equal((await approvals(store)).length, 0);
  assert.match((await store.get<any>("leads", "gohighlevel:OPP2")).reason, /no contact/);
});

test("pipedrive: a touch is a call task and a note in the CRM, no send is queued, and a lost move is queued", async () => {
  deals = { NEW1: [{ id: 101, title: "Kitchen quote", stage_id: 1, status: "open" }] };
  const store = new MemoryStore();
  await intake(ctxFor(PD, store));
  await draft(ctxFor(PD, store));
  assert.equal(sendHits().length, 0);
  assert.ok(hits.some((h) => h.path === "/api/v2/activities"), "a call task is drafted");
  assert.ok(hits.some((h) => h.path === "/v1/notes"), "a note with the message is drafted");
  assert.equal((await approvals(store)).length, 0, "Pipedrive has no mapped send, so none is queued");
  await draft(ctxFor(PD, store, DAYS(3)));
  await draft(ctxFor(PD, store, DAYS(10)));
  await chase(ctxFor(PD, store, DAYS(24)));
  const lost = await approvals(store);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].acts[0].op, "openapi-v2.updateDeal");
  assert.equal(stageHits().length, 0, "a cron never marks a deal lost");
});

test("ids and settings from outside are checked before any call is made", async () => {
  const store = new MemoryStore();
  await assert.rejects(intake(ctxFor({ ...GHL, pipeline_id: "../x" }, store)), /plain id/);
  await assert.rejects(intake(ctxFor({ ...GHL, watch: [{ stage_id: "NEW1/../../x", role: "lead" }] }, store)), /plain id/);
  await assert.rejects(intake(ctxFor({ ...GHL, follow_up: { after_days: [0] } }, store)), /after_days/);
  assert.equal(hits.length, 0);
});
