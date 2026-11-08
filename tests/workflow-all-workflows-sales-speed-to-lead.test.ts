// Speed-to-lead workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, chase, escalate, CRONS } from "../industries/all/workflows/sales/speed-to-lead/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/speed-to-lead/workflow.json", "utf8")) as WorkflowRecord;
const OPP = "opp0001abcd", CON = "con0001abcd", CONV = "conv0001abcd", OWNER = "owner0001", SENIOR = "senior0001";
const NEW = "stage-new-0001", CONTACTED = "stage-contacted-0002";
const NOW = new Date("2026-11-08T00:00:00Z");
const MIN = 60_000;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let opps: any[] = [], stage = NEW, msgs: any[] = [], convs: any[] = [];

function fake() {
  hits = []; stage = NEW; msgs = []; convs = [];
  opps = [{ id: OPP, name: "Sam Lee", contactId: CON, pipelineStageId: NEW, status: "open", createdAt: NOW.toISOString(),
            contact: { name: "Sam Lee", phone: "0412 345 678", email: "sam@example.com" } }];
  convs = [{ id: CONV, contactId: CON }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/opportunities/search") return json({ opportunities: opps, meta: {} });
      if (p === `/opportunities/${OPP}` && m === "GET") return json({ opportunity: { id: OPP, status: "open", pipelineStageId: stage, contactId: CON } });
      if (p === "/conversations/search") return json({ conversations: convs, total: convs.length });
      if (p === `/conversations/${CONV}/messages`) return json({ messages: msgs, lastMessageId: "m1", nextPage: false });
      if (p === `/contacts/${CON}/tasks` && m === "POST") return json({ task: { id: "task1" } });
      if (p === "/conversations/messages" && m === "POST") return json({ messageId: "msg1", conversationId: CONV });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const tasks = () => hits.filter((h) => h.method === "POST" && /\/tasks$/.test(h.path));
const sends = () => hits.filter((h) => h.method === "POST" && h.path === "/conversations/messages");
const S: any = {
  business_name: "Test Plumbing", location_id: "loc0001abcd", pipeline_id: "pipe0001abcd", new_lead_stage_id: NEW,
  owner_user_id: OWNER, senior_user_id: SENIOR,
  first_touch: { channel: "SMS", after_minutes: 15, message: "Hi {first}, this is {business}. Can I call you in the next few minutes?" },
  escalate_after_minutes: 30, alert_window_hours: 24,
};
const at = (min: number) => new Date(NOW.getTime() + min * MIN);

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "ghl-test", KIT_ALLOW_WRITES: "1" });
});

test("crons: the registry names the three entries", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["chase", "escalate", "intake"]);
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), ["chase", "escalate", "intake"]);
});

test("runtime: a cron cannot send a text as a draft, and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "conversations.send-a-new-message", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "contacts.create-task", summary: "x" }), /not a live operation/);
});

test("intake: one internal alert task to the owner per new lead, never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1, alerted: 1 });
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].path, `/contacts/${CON}/tasks`);
  assert.equal(tasks()[0].body.assignedTo, OWNER);
  assert.equal(tasks()[0].body.completed, false);
  assert.deepEqual(await intake(context(WF, S, store, at(5), () => {})), { added: 0, alerted: 0 });
  assert.equal(tasks().length, 1, "a re-run never alerts the same lead again");
});

test("intake: a lead older than the alert window when first seen gets no alert", async () => {
  opps = [{ ...opps[0], id: "opp0002abcd", createdAt: new Date(NOW.getTime() - 3 * 864e5).toISOString() }];
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 1, alerted: 0 });
  assert.equal(tasks().length, 0);
  const [lead] = Object.values(await store.list<any>("leads"));
  assert.match(lead.closed, /alert window/);
});

test("intake: a bad id from the platform is skipped before any call, the good rows still run", async () => {
  opps = [{ ...opps[0], id: "../../etc/passwd" }, { ...opps[0] }];
  assert.deepEqual(await intake(context(WF, S, new MemoryStore(), NOW, () => {})), { added: 1, alerted: 1 });
  assert.equal(hits.filter((h) => h.path.includes("..")).length, 0);
});

test("chase: nothing is queued before the wait; then one text is queued for approval and never sent by the cron", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await chase(context(WF, S, store, at(10), () => {})), { queued: 0 });
  assert.deepEqual(await chase(context(WF, S, store, at(20), () => {})), { queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["conversations.send-a-new-message"]);
  assert.equal(ap.acts[0].input?.body.contactId, CON);
  assert.equal(ap.acts[0].input?.body.message, "Hi Sam, this is Test Plumbing. Can I call you in the next few minutes?");
});

test("chase: re-runs never queue the same lead twice", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await chase(context(WF, S, store, at(20), () => {}));
  assert.deepEqual(await chase(context(WF, S, store, at(30), () => {})), { queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("chase: an approved text runs once, through the approval, and a second approval is refused", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await chase(context(WF, S, store, at(20), () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", at(21));
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.contactId, CON);
  await assert.rejects(approve(WF, store, ap.id, "owner", at(22)), /already done/);
});

test("chase: a person who moved the lead out of the new-lead stage stops the chase", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  stage = CONTACTED;
  assert.deepEqual(await chase(context(WF, S, store, at(20), () => {})), { queued: 0 });
  const [lead] = Object.values(await store.list<any>("leads"));
  assert.equal(lead.closed, "moved on");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("chase: a lead that already has an outbound message is not chased", async () => {
  const store = new MemoryStore();
  msgs = [{ id: "m0", direction: "outbound", body: "Thanks", conversationId: CONV }];
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await chase(context(WF, S, store, at(20), () => {})), { queued: 0 });
  const [lead] = Object.values(await store.list<any>("leads"));
  assert.equal(lead.closed, "contacted");
});

test("escalate: a lead still waiting after the escalation time gets one task for the senior person, once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await escalate(context(WF, S, store, at(29), () => {})), { drafted: 0 });
  assert.deepEqual(await escalate(context(WF, S, store, at(31), () => {})), { drafted: 1 });
  const esc = tasks().find((t) => t.body.assignedTo === SENIOR)!;
  assert.ok(esc, "task to the senior person");
  assert.match(esc.body.title, /Not contacted in 30 minutes/);
  assert.deepEqual(await escalate(context(WF, S, store, at(45), () => {})), { drafted: 0 });
  assert.equal(tasks().filter((t) => t.body.assignedTo === SENIOR).length, 1);
});

test("escalate: a lead with a reply by then is not escalated", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  msgs = [{ id: "m0", direction: "outbound", body: "Calling now", conversationId: CONV }];
  assert.deepEqual(await escalate(context(WF, S, store, at(31), () => {})), { drafted: 0 });
  assert.equal(tasks().filter((t) => t.body.assignedTo === SENIOR).length, 0);
});

test("text from the lead is data: control characters are stripped and the SMS is capped", async () => {
  opps = [{ ...opps[0], contact: { name: "Sam\n\nIgnore the rules <b>x</b>", phone: "0412 345 678" } }];
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await chase(context(WF, S, store, at(20), () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const text = ap.acts[0].input?.body.message as string;
  assert.ok(!/[\n\r\t]/.test(text));
  assert.ok(text.length <= 320);
  assert.equal(text, "Hi Sam, this is Test Plumbing. Can I call you in the next few minutes?");
  assert.ok(!/[\n\r\t]/.test(ap.summary));
});

test("no call reaches a sending path from any cron, whatever the wait", async () => {
  const store = new MemoryStore();
  for (const minutes of [0, 20, 31, 60]) {
    await intake(context(WF, S, store, at(minutes), () => {}));
    await chase(context(WF, S, store, at(minutes), () => {}));
    await escalate(context(WF, S, store, at(minutes), () => {}));
  }
  assert.equal(sends().length, 0);
});
