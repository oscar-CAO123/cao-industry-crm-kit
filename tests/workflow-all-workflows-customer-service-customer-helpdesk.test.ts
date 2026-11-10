// Customer helpdesk workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, chase } from "../industries/all/workflows/customer-service/customer-helpdesk/index.ts";
import { checkSettings } from "../industries/all/workflows/customer-service/customer-helpdesk/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/customer-service/customer-helpdesk/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const NOW_S = NOW.getTime() / 1000;

const S: any = {
  business_name: "Test Store", sources: ["front", "gorgias"],
  front: { inbox_id: "inb_1", channel_id: "cha_1", teammate_id: "tea_1" },
  answers: [
    { name: "opening hours", match: ["opening hours", "open on", "what time"], front: { article_id: "kba_hours" } },
    { name: "delivery", match: ["deliver"], gorgias: { macro_id: 23 } },
  ],
  escalate: ["refund", "complaint"],
  lookback_hours: 24, chase_after_hours: 4, signature: "Thanks, Test Store",
};

type Hit = { method: string; host: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let articleStatus = "published";

const FRONT_CONVS = [
  { id: "cnv_1", subject: "Opening hours", is_closed: false, assignee: null, recipient: { handle: "ann@example.com", name: "Ann" }, created_at: NOW_S - 3600 },
  { id: "cnv_old", subject: "Hours", is_closed: false, assignee: null, recipient: { handle: "old@example.com" }, created_at: NOW_S - 3 * 86400 },
  { id: "cnv_2", subject: "Crypto payments", is_closed: false, assignee: null, recipient: { handle: "bev@example.com", name: "Bev" }, created_at: NOW_S - 6 * 3600 },
  { id: "cnv_assigned", subject: "Hours", is_closed: false, assignee: { id: "tea_9" }, recipient: {}, created_at: NOW_S - 600 },
];
const FRONT_MSGS: Record<string, any[]> = {
  cnv_1: [{ is_inbound: true, text: "What time do you open on Saturday?", created_at: NOW_S - 3500 }, { is_inbound: false, text: "Hi", created_at: NOW_S - 4000 }],
  cnv_old: [{ is_inbound: true, text: "Hours?", created_at: NOW_S - 3 * 86400 }],
  cnv_2: [{ is_inbound: true, text: "Do you take crypto?", created_at: NOW_S - 6 * 3600 }],
};
const ARTICLE = () => ({ id: "kba_hours", name: "Hours", status: articleStatus,
  content: "<p>We open at 8am and close at 4pm on Saturday.</p><p>We are closed on Sundays.</p>" });

const GORGIAS_TICKETS = [
  { id: 501, status: "open", subject: "Refund for order 1001", channel: "email", via: "email", created_datetime: "2026-11-07T10:00:00.123456", customer: { id: 77, email: "bo@example.com", name: "Bo" } },
  { id: 502, status: "open", subject: "Delivery", channel: "email", via: "email", created_datetime: "2026-11-07T11:00:00.000000", customer: { id: 78, email: "cy@example.com", name: "Cy" } },
  { id: 499, status: "open", subject: "Old", channel: "email", via: "email", created_datetime: "2026-10-01T00:00:00.000000", customer: { id: 60 } },
  { id: 503, status: "closed", subject: "Closed", channel: "email", via: "email", created_datetime: "2026-11-07T12:00:00.000000", customer: { id: 61 } },
];
const GORGIAS_MSGS: Record<string, any[]> = {
  "501": [{ from_agent: false, body_text: "I want a refund for order 1001" }],
  "502": [{ from_agent: false, body_text: "Do you deliver on Sundays?" }],
  "499": [{ from_agent: false, body_text: "old question" }],
};
const MACRO_23 = { id: 23, archived_datetime: null, actions: [{ name: "setResponseText", arguments: { body_text: "We deliver Monday to Saturday, and orders placed before noon go out the same day." } }] };

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.host, path: p, query: u.searchParams, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.host === "api2.frontapp.com") {
        if (p === "/inboxes/inb_1/conversations") return json({ _results: FRONT_CONVS });
        const msg = p.match(/^\/conversations\/([^/]+)\/messages$/);
        if (msg && m === "GET") return json({ _results: FRONT_MSGS[msg[1]] ?? [] });
        if (msg && m === "POST") return json({ id: "msg_1" }, 202);
        if (p === "/knowledge_base_articles/kba_hours") return json(ARTICLE());
        if (/^\/conversations\/[^/]+\/(assignee|reminders)$/.test(p)) return json({});
        return json({ error: "not faked: " + p }, 404);
      }
      if (u.host === "acme.gorgias.com") {
        if (p === "/api/tickets") return json({ data: GORGIAS_TICKETS, meta: {} });
        if (p === "/api/messages") return json({ data: GORGIAS_MSGS[u.searchParams.get("ticket_id") ?? ""] ?? [] });
        if (p === "/api/macros/23") return json(MACRO_23);
        if (/^\/api\/tickets\/\d+\/(tags|messages)$/.test(p)) return json({ id: 1 }, 201);
        return json({ error: "not faked: " + p }, 404);
      }
      return json({ error: "not faked: " + u.host }, 404);
    }) as any,
  });
}

const ctxOf = (s: MemoryStore, now = NOW) => context(WF, S, s, now, () => {});
const sends = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); articleStatus = "published"; setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FRONT_API_TOKEN: "front-test-token", GORGIAS_EMAIL: "ops@example.com", GORGIAS_API_KEY: "gorgias-test-key",
    GORGIAS_DOMAIN: "acme", KIT_ALLOW_WRITES: "1" });
});

test("intake reads open questions inside the lookback window, once, and writes nothing", async () => {
  const s = new MemoryStore();
  const first = await intake(ctxOf(s));
  assert.equal(first.added, 4, "two Front conversations and two Gorgias tickets; old, assigned and closed ones are left out");
  assert.equal((await intake(ctxOf(s))).added, 0, "a second run adds nothing");
  assert.equal(writes().length, 0, "intake is read only");
  const all = await s.list<any>("enquiries");
  assert.deepEqual(Object.values(all).map((e: any) => e.status), ["new", "new", "new", "new"]);
});

test("settings: an answer rule with no match words is refused before any cron runs", () => {
  const noMatch = { ...S, answers: [{ name: "hours", front: { article_id: "kba_hours" } }] };
  assert.throws(() => checkSettings(noMatch), /answer rule hours needs match words/);
  assert.throws(() => checkSettings({ ...S, answers: [{ name: "hours", match: [], front: { article_id: "kba_hours" } }] }), /needs match words/);
  checkSettings(S);
});

test("draft queues matched answers for approval, escalates sensitive ones, parks the rest, and sends nothing", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  const r = await draft(ctxOf(s));
  assert.deepEqual(r, { queued: 2, escalated: 1, needs_answer: 1 });
  assert.equal(sends().length, 0, "no message reached a customer during the cron");

  const enq = await s.list<any>("enquiries");
  assert.equal(enq["front:cnv_1"].status, "answer-queued");
  assert.equal(enq["gorgias:502"].status, "answer-queued");
  assert.equal(enq["gorgias:501"].status, "escalated");
  assert.equal(enq["front:cnv_2"].status, "needs-answer");
  assert.match(enq["front:cnv_2"].reason, /no answer rule/);

  const tag = hits.find((h) => h.method === "POST" && h.path === "/api/tickets/501/tags");
  assert.deepEqual(tag?.body, { names: ["needs-human"] }, "the escalated ticket is tagged for a person");

  const pending = Object.values(await s.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending"));
  const frontAct = pending.find((a) => a.acts[0].platform === "front")!.acts[0];
  assert.equal(frontAct.op, "core-api_core-api.create-message-reply");
  assert.equal(frontAct.input?.body?.channel_id, "cha_1");
  assert.match(frontAct.input?.body?.body, /8am/);
  assert.match(frontAct.input?.body?.body, /Thanks, Test Store/, "the signature is added to the answer");
});

test("approval sends each reply once, and re-runs never queue it again", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  await draft(ctxOf(s));
  const frontId = approvalId(WF.id, "reply:front:cnv_1");
  const gorgiasId = approvalId(WF.id, "reply:gorgias:502");

  const fa = await approve(WF, s, frontId, "tester");
  assert.equal(fa.status, "done");
  const ga = await approve(WF, s, gorgiasId, "tester");
  assert.equal(ga.status, "done");

  const frontSend = hits.find((h) => h.method === "POST" && h.path === "/conversations/cnv_1/messages");
  assert.ok(frontSend, "Front reply sent after approval");
  const gorgiasSend = hits.find((h) => h.method === "POST" && h.path === "/api/tickets/502/messages");
  assert.ok(gorgiasSend, "Gorgias reply sent after approval");
  assert.equal(gorgiasSend?.body.from_agent, true);
  assert.equal(gorgiasSend?.body.receiver.id, 78);
  assert.match(gorgiasSend?.body.body_text, /Monday to Saturday/);

  assert.equal((await draft(ctxOf(s))).queued, 0, "a second draft run queues nothing new");
  assert.equal((await intake(ctxOf(s))).added, 0);
  assert.equal(Object.keys(await s.list("approvals")).length, 2, "still two approvals");
  await assert.rejects(approve(WF, s, frontId, "tester"), /already done/, "an approved reply cannot be sent twice");
});

test("live operations cannot be drafted, and draft operations cannot be queued", async () => {
  const c = ctxOf(new MemoryStore());
  await assert.rejects(c.draft({ platform: "front", op: "core-api_core-api.create-message-reply", summary: "x" }), /not a draft operation/);
  await assert.rejects(c.draft({ platform: "gorgias", op: "docs.post_tickets_ticket_id_messages", summary: "x" }), /not a draft operation/);
  await assert.rejects(c.queue({ platform: "front", op: "core-api_core-api.update-conversation-assignee", summary: "x", input: {} }), /not a live operation/);
  await assert.rejects(c.queue({ platform: "gorgias", op: "docs.post_tickets_ticket_id_tags", summary: "x", input: {} }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("chase sets one reminder on a waiting question, and only once", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  await draft(ctxOf(s));
  assert.equal((await chase(ctxOf(s))).chased, 1);
  const rem = hits.find((h) => h.method === "PATCH" && h.path === "/conversations/cnv_2/reminders");
  assert.ok(rem, "Front reminder set on the waiting question");
  assert.equal(rem?.body.teammate_id, "tea_1");
  assert.ok(rem?.body.scheduled_at > NOW_S, "the reminder is in the future");
  assert.equal((await chase(ctxOf(s))).chased, 0, "a second chase sets nothing");
  assert.equal(hits.filter((h) => h.path === "/conversations/cnv_2/reminders").length, 1);
});

test("an unpublished help article is never sent", async () => {
  articleStatus = "draft";
  const s = new MemoryStore();
  await intake(ctxOf(s));
  const r = await draft(ctxOf(s));
  assert.equal(r.queued, 1, "only the Gorgias macro answer is queued");
  const enq = await s.list<any>("enquiries");
  assert.equal(enq["front:cnv_1"].status, "needs-answer");
  assert.match(enq["front:cnv_1"].reason, /no usable published front article/);
});
