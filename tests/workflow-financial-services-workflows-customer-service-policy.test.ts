// Policy-answers workflow tests. Every request goes to a fake network: no test reaches a real Zendesk account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp, CRONS } from "../industries/financial-services/workflows/customer-service/policy/index.ts";
import fs from "node:fs";

const FOLDER = "industries/financial-services/workflows/customer-service/policy";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { intake: ["zendesk"], zendesk: { locale: "en-au", group_id: 7 }, follow_up: { after_days: [3, 7] } };
const NOW = new Date("2026-11-08T00:00:00Z");
const DAY = 864e5;

const TICKETS = [
  { id: 101, subject: "Is flood cover included in my home policy?", description: "My house flooded last week. Does flood cover apply?", status: "new", group_id: 7, requester_id: 55, created_at: "2026-11-07T23:00:00Z" },
  { id: 102, subject: "Motor excess question", description: "What is my excess?", status: "solved", group_id: 7, requester_id: 56, created_at: "2026-11-06T01:00:00Z" },
  { id: 103, subject: "Stolen bike claim", description: "Someone took my bike from the shed, what do I do?", status: "open", group_id: 7, requester_id: 57, created_at: "2026-11-07T20:00:00Z" },
  { id: 104, subject: "Flood cover question", description: "Is flood cover included?", status: "new", group_id: 9, requester_id: 58, created_at: "2026-11-07T22:00:00Z" },
];
const ARTICLES = [{ id: 9001, title: "Flood cover in your home policy", draft: false, html_url: "https://acme.zendesk.com/hc/en-au/articles/9001",
  body: "<p>Flood cover is included in the home building section, subject to the excess shown in your schedule.</p>" }];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let ticketStatus = "open";

function fake() {
  hits = []; ticketStatus = "open";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/v2/tickets" && m === "GET") return json({ tickets: TICKETS });
      if (p === "/api/v2/help_center/en-au/articles" && m === "GET") return json({ articles: ARTICLES });
      if (p === "/api/v2/tickets/101" && m === "GET") return json({ ticket: { id: 101, status: ticketStatus } });
      if (p === "/api/v2/tickets/101" && m === "PUT") return json({ ticket: { id: 101 } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));

beforeEach(() => {
  fake();
  Object.assign(process.env, { ZENDESK_SUBDOMAIN: "acme", ZENDESK_EMAIL: "ops@example.com", ZENDESK_API_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
});

test("the cron entries in workflow.json are the ones the code exports", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("intake reads only open tickets in the group and writes nothing", async () => {
  const store = new MemoryStore();
  const r = await intake(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(r.added, 2);
  assert.deepEqual(Object.keys(await store.list("enquiries")).sort(), ["101", "103"]);
  assert.equal(writes().length, 0);
});

test("draft queues a reply for approval and never sends it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  const r = await draft(ctx);
  assert.equal(r.drafted, 1);
  assert.equal(r.needs_answer, 1);
  assert.equal(writes().length, 0, "a cron run makes no write request");
  const ap = await store.get<Approval>("approvals", approvalId(WF.id, "reply:101"));
  assert.equal(ap?.status, "pending");
  assert.equal(ap?.acts[0].op, "core.UpdateTicket");
  assert.equal(ap?.acts[0].input?.body?.ticket?.comment?.public, true);
  assert.match(ap?.acts[0].input?.body?.ticket?.comment?.body ?? "", /Flood cover in your home policy/);
});

test("re-runs never double-queue", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  await intake(ctx); await draft(ctx); await draft(ctx);
  assert.equal((await approvals(store)).length, 1);
  assert.equal(writes().length, 0);
});

test("a live operation cannot run as a draft, and a draft operation cannot be queued as live", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "zendesk", op: "core.UpdateTicket", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "zendesk", op: "core.ListTickets", summary: "x" }), /not a live operation/);
});

test("approval sends the reply once; a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const id = approvalId(WF.id, "reply:101");
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  const puts = writes().filter((h) => h.method === "PUT" && h.path === "/api/v2/tickets/101");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.ticket.comment.public, true);
  await assert.rejects(approve(WF, store, id, "owner", NOW), /already done/);
  assert.equal(writes().length, 1);
});

test("follow-up marks the reply sent, queues one chaser when due, and closes solved tickets", async () => {
  const store = new MemoryStore();
  const first = context(WF, SETTINGS, store, NOW, () => {});
  await intake(first); await draft(first);
  await approve(WF, store, approvalId(WF.id, "reply:101"), "owner", NOW);

  assert.equal((await followUp(context(WF, SETTINGS, store, NOW, () => {}))).queued, 0, "not due on the day of the reply");
  const later = new Date(NOW.getTime() + 4 * DAY);
  assert.equal((await followUp(context(WF, SETTINGS, store, later, () => {}))).queued, 1, "chaser due after 3 days");
  assert.equal((await followUp(context(WF, SETTINGS, store, later, () => {}))).queued, 0, "a second run never repeats it");
  assert.equal(writes().length, 1, "chasers are queued, not sent");
  assert.equal((await approvals(store)).length, 2);
});

test("follow-up closes an answer once its ticket is solved", async () => {
  const store = new MemoryStore();
  const first = context(WF, SETTINGS, store, NOW, () => {});
  await intake(first); await draft(first);
  await approve(WF, store, approvalId(WF.id, "reply:101"), "owner", NOW);
  ticketStatus = "solved";
  const later = new Date(NOW.getTime() + 4 * DAY);
  assert.equal((await followUp(context(WF, SETTINGS, store, later, () => {}))).queued, 0);
  assert.equal((await store.get<any>("answers", "101"))?.status, "closed");
});
