// Lead capture workflow tests. Every request goes to a fake network: no test reaches a real GoHighLevel location.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, acknowledge, followUp } from "../industries/all/workflows/sales/lead-capture/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/lead-capture/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/forms/submissions") return json({ submissions: [
        { id: "sub1", contactId: "ctc1", createdAt: "2026-11-08T01:00:00.000Z", formId: "f1", name: "Ari Lee", email: "ari@example.com", others: {} },
        { id: "sub0", contactId: "ctc0", createdAt: "2026-11-01T00:00:00.000Z", formId: "f1", name: "Old Lead", email: "old@example.com", others: {} },
        { id: "sub2", contactId: "../x", createdAt: "2026-11-08T02:00:00.000Z", formId: "f1", name: "Bad Id", email: "bad@example.com", others: {} },
      ], meta: {} });
      if (p === "/conversations/search") {
        if (u.searchParams.get("contactId")) return json({ conversations: [{ id: "conv1", contactId: "ctc1", unreadCount: 0 }] });
        return json({ conversations: [
          { id: "chat1", contactId: "ctc2", unreadCount: 1, fullName: "Sam <i>Ng</i>", email: "sam@example.com", phone: "", type: "Live_Chat" },
          { id: "chat2", contactId: "ctc3", unreadCount: 0, fullName: "Quiet Visitor", email: "quiet@example.com" },
        ], total: 2 });
      }
      if (/\/contacts\/[^/]+\/tags$/.test(p) && m === "POST") return json({ tags: [] });
      if (p === "/opportunities/" && m === "POST") return json({ opportunity: { id: `opp${hits.length}` } });
      if (/\/contacts\/[^/]+\/appointments$/.test(p)) return json({ events: [] });
      if (p === "/conversations/messages" && m === "POST") return json({ messageId: "m1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path === "/conversations/messages" && h.method === "POST");
const opps = () => hits.filter((h) => h.path === "/opportunities/" && h.method === "POST");

const SETTINGS: any = {
  business_name: "Smith & Co <test>",
  gohighlevel: { location_id: "LOC1", pipeline_id: "PIPE1", new_stage_id: "STAGE1", owner_user_id: "USER1" },
  lead_tags: ["web-lead"],
  acknowledgement: { channel: "Email", subject: "Thanks", text: "Hi {first}, thanks for getting in touch with {business}." },
  follow_up: { after_hours: 48, max: 2, text: "Hi {first}, just checking you got our message." },
};
const NOW = new Date("2026-11-08T00:00:00Z");
const HOUR = 36e5;

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "tok", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "conversations.send-a-new-message", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "opportunities.create-opportunity", summary: "x" }), /not a live operation/);
});

test("intake: the first run only sets the baseline; later runs record new leads, tag them and open opportunities, and never message", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 0, baseline: true });
  assert.equal(opps().length, 0, "old submissions are not imported on the first run");

  const later = context(WF, SETTINGS, store, new Date(NOW.getTime() + HOUR), () => {});
  assert.deepEqual(await intake(later), { added: 2 });
  assert.equal(opps().length, 2, "one opportunity for the form lead, one for the open chat");
  assert.equal(opps()[0].body.pipelineStageId, "STAGE1");
  assert.equal(opps()[0].body.assignedTo, "USER1");
  assert.equal(sends().length, 0, "intake sends nothing");
  assert.ok(!hits.some((h) => h.path === "/contacts/../x/tags"), "a contact id with a dot is refused");

  assert.deepEqual(await intake(later), { added: 0 }, "a re-run never records or opens a lead twice");
  assert.equal(opps().length, 2);
});

test("acknowledge: queues one approval per new lead, never sends, and a re-run never queues twice", async () => {
  const store = new MemoryStore(), t1 = new Date(NOW.getTime() + HOUR);
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await intake(context(WF, SETTINGS, store, t1, () => {}));
  const ctx = context(WF, SETTINGS, store, t1, () => {});
  assert.deepEqual(await acknowledge(ctx), { queued: 2, skipped: 0 });
  assert.equal(sends().length, 0, "nothing is sent by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 2);
  assert.deepEqual(await acknowledge(ctx), { queued: 0, skipped: 0 }, "already queued leads are not queued again");
  assert.equal(Object.keys(await store.list("approvals")).length, 2);
});

test("approval sends the escaped acknowledgement once; a second approval is refused", async () => {
  const store = new MemoryStore(), t1 = new Date(NOW.getTime() + HOUR);
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await intake(context(WF, SETTINGS, store, t1, () => {}));
  await acknowledge(context(WF, SETTINGS, store, t1, () => {}));
  const ap = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].input?.body?.contactId === "ctc1")!;
  const done = await approve(WF, store, ap.id, "owner", t1);
  assert.equal(done.status, "done");
  const sent = sends();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.type, "Email");
  assert.equal(sent[0].body.contactId, "ctc1");
  assert.equal(sent[0].body.html, "<p>Hi Ari, thanks for getting in touch with Smith &amp; Co &lt;test&gt;.</p>", "business name is escaped, not raw");
  await assert.rejects(approve(WF, store, ap.id, "owner", t1), /already done/);
  assert.equal(sends().length, 1);
});

test("follow-up waits for the set hours, queues up to the maximum, and skips a lead with an unanswered message", async () => {
  const store = new MemoryStore(), t1 = new Date(NOW.getTime() + HOUR);
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await intake(context(WF, SETTINGS, store, t1, () => {}));
  await acknowledge(context(WF, SETTINGS, store, t1, () => {}));
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 24 * HOUR), () => {})), { queued: 0 }, "not due yet");
  const due = new Date(NOW.getTime() + 60 * HOUR);
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, due, () => {})), { queued: 2 });
  assert.equal(sends().length, 0, "follow-ups are queued, not sent");
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, due, () => {})), { queued: 0 }, "not due again the same day");
  const again = new Date(due.getTime() + 49 * HOUR);
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, again, () => {})), { queued: 2 }, "second follow-up");
  const third = new Date(again.getTime() + 49 * HOUR);
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, third, () => {})), { queued: 0 }, "the maximum is two");
});

test("follow-up marks a lead replied when an unanswered message is waiting on staff", async () => {
  const store = new MemoryStore(), t1 = new Date(NOW.getTime() + HOUR);
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await intake(context(WF, SETTINGS, store, t1, () => {}));
  await acknowledge(context(WF, SETTINGS, store, t1, () => {}));
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname === "/conversations/search" && u.searchParams.get("contactId") === "ctc1") return json({ conversations: [{ id: "conv1", contactId: "ctc1", unreadCount: 2 }] });
    if (/\/appointments$/.test(u.pathname)) return json({ events: [] });
    return json({ conversations: [] });
  }) as any });
  const out = await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 60 * HOUR), () => {}));
  assert.deepEqual(out, { queued: 1 }, "only the lead with no waiting message is chased");
  const statuses = Object.values(await store.list<any>("leads")).map((l: any) => [l.contactId, l.status]).sort();
  assert.deepEqual(statuses, [["ctc1", "replied"], ["ctc2", "queued"]]);
});
