// Inbox-triage workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, assign } from "../industries/all/workflows/customer-service/inbox-triage/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/customer-service/inbox-triage";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      // Front
      if (p === "/inboxes/inb_1/conversations") return json({ _results: [
        { id: "cnv_1", subject: "Quote for a blocked drain", description: "Can you quote the job?", recipient: { name: "Ari", handle: "ari@example.com" }, assignee: null, is_closed: false, created_at: 1762560000 },
        { id: "cnv_2", subject: "Opening hours question", description: "Are you open Saturday?", recipient: { name: "Kim", handle: "kim@example.com" }, assignee: null, is_closed: false, created_at: 1762560000 },
        { id: "cnv_3", subject: "Newsletter: spring offers", description: "Click to unsubscribe", recipient: { name: "Shop", handle: "news@shop.example" }, assignee: null, is_closed: false, created_at: 1762560000 },
        { id: "cnv_4", subject: "Already with Jo", description: "Thanks", recipient: { name: "Lee", handle: "lee@example.com" }, assignee: { id: "tea_9" }, is_closed: false, created_at: 1762560000 },
        { id: "../evil", subject: "Bad id", description: "x", recipient: { handle: "x@example.com" }, assignee: null, is_closed: false, created_at: 1762560000 },
      ] });
      if (/^\/conversations\/[^/]+\/assignee$/.test(p)) return json({});
      if (/^\/conversations\/[^/]+\/reminders$/.test(p)) return json({});
      if (/^\/conversations\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: "msg_1" });
      // Gmail
      if (p === "/gmail/v1/users/me/threads") return json({ threads: [{ id: "thr1" }, { id: "thr2" }] });
      if (p === "/gmail/v1/users/me/threads/thr1" && m === "GET") return json({ id: "thr1", messages: [
        { id: "m1", labelIds: ["INBOX", "UNREAD"], internalDate: "1762560000000", snippet: "Are you open on Saturday?",
          payload: { headers: [{ name: "Subject", value: "Opening hours?" }, { name: "From", value: '"Sam Lee" <sam@example.com>' }] } } ] });
      if (p === "/gmail/v1/users/me/threads/thr2" && m === "GET") return json({ id: "thr2", messages: [
        { id: "m2", labelIds: ["SENT"], internalDate: "1762560000000", snippet: "Our reply", payload: { headers: [{ name: "Subject", value: "Old" }, { name: "From", value: "ops@example.com" }] } } ] });
      if (p === "/gmail/v1/users/me/labels") return json({ labels: [{ id: "Label_9", name: "Needs reply" }] });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: "r-draft-1", message: { id: "m10" } });
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "m11" });
      if (/^\/gmail\/v1\/users\/me\/threads\/[^/]+\/modify$/.test(p)) return json({ id: "thr1" });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

// Sends are the only calls that reach a customer: a Front reply or a Gmail draft send.
const sends = () => hits.filter((h) => (h.method === "POST" && /^\/conversations\/[^/]+\/messages$/.test(h.path)) || h.path === "/gmail/v1/users/me/drafts/send");

const SETTINGS: any = {
  business_name: "Test Co", sources: ["front", "google-workspace"],
  front: { inbox_id: "inb_1", channel_id: "cha_1", teammate_id: "tea_1" },
  google: { label_name: "Needs reply" },
  triage: [
    { category: "noise", match: ["unsubscribe", "newsletter"] },
    { category: "complaint", match: ["complaint", "refund"] },
    { category: "quote-request", match: ["quote"] },
    { category: "question", match: ["opening hours"] },
  ],
  auto_reply: [{ category: "question", match: ["opening hours"], body: "We are open 8am to 5pm, Monday to Friday." }],
  sla_hours: 4,
  signature: "Test Co team",
};
const NOW = new Date("2025-11-08T06:00:00Z");

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { FRONT_API_TOKEN: "f_test", GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("intake sorts mail, skips noise and our own sent threads, and refuses a bad conversation id", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 4 });
  const all = await store.list<any>("enquiries");
  assert.equal(all["front:cnv_1"].category, "quote-request");
  assert.equal(all["front:cnv_1"].status, "triaged");
  assert.equal(all["front:cnv_3"].status, "skipped");
  assert.equal(all["gmail:thr1"].category, "question");
  assert.equal(all["gmail:thr1"].sender.email, "sam@example.com");
  assert.equal(Object.keys(all).some((k) => k.includes("evil") || k.includes("cnv_4") || k.includes("thr2")), false);
  assert.deepEqual(await intake(ctx), { added: 0 }, "re-runs add nothing new");
});

test("draft queues approved template replies only; nothing is sent by a cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 2, needs_reply: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 2);
  const gmailDraft = hits.find((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST")!.body;
  assert.equal(gmailDraft.message.threadId, "thr1");
  const raw = Buffer.from(gmailDraft.message.raw, "base64url").toString("utf8");
  assert.match(raw, /To: sam@example\.com/);
  assert.ok(raw.includes(Buffer.from("Re: Opening hours?").toString("base64")), "subject encoded");
  const ids = approvals.map((a) => a.id).sort();
  assert.equal(ids.length, new Set(ids).size);
});

test("re-runs never double-queue or double-draft", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await draft(ctx), { queued: 0, needs_reply: 1 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
  assert.equal(hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST").length, 1, "one Gmail draft");
});

test("approval runs the send: a Front reply and a Gmail draft send, once each", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  for (const ap of approvals) assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(sends().length, 2);
  const reply = sends().find((h) => h.path === "/conversations/cnv_2/messages")!.body;
  assert.equal(reply.channel_id, "cha_1");
  assert.match(reply.body, /We are open 8am to 5pm/);
  assert.match(reply.body, /Test Co team/);
  assert.deepEqual(sends().find((h) => h.path === "/gmail/v1/users/me/drafts/send")!.body, { id: "r-draft-1" });
  for (const ap of approvals) await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("assign: Front gets the teammate and a future reminder, Gmail gets the label; each thread once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await assign(ctx), { assigned: 3 });
  const assignee = hits.filter((h) => h.path.endsWith("/assignee"));
  assert.deepEqual(assignee.map((h) => [h.path, h.body.assignee_id]), [["/conversations/cnv_1/assignee", "tea_1"], ["/conversations/cnv_2/assignee", "tea_1"]]);
  const reminders = hits.filter((h) => h.path.endsWith("/reminders"));
  assert.equal(reminders.length, 2);
  for (const r of reminders) {
    assert.equal(r.body.teammate_id, "tea_1");
    assert.ok(r.body.scheduled_at * 1000 > NOW.getTime(), "reminder is in the future");
  }
  const modify = hits.find((h) => h.path === "/gmail/v1/users/me/threads/thr1/modify")!.body;
  assert.deepEqual(modify, { addLabelIds: ["Label_9"] });
  assert.deepEqual(await assign(ctx), { assigned: 0 });
});

test("a cron cannot draft a send or queue a label change, and a reply body is escaped", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "front", op: "core-api_core-api.create-message-reply", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.labels.create", summary: "x" }), /not a live operation/);
  assert.equal(sends().length, 0);

  const evil = { ...SETTINGS, signature: "<b>Team</b>" }, s2 = new MemoryStore(), c2 = context(WF, evil, s2, NOW, () => {});
  await intake(c2); await draft(c2);
  const front = Object.values(await s2.list<Approval>("approvals")).find((a) => a.acts[0].op === "core-api_core-api.create-message-reply")!;
  assert.match(front.acts[0].input!.body.body, /&lt;b&gt;Team&lt;\/b&gt;/);
  assert.ok(!front.acts[0].input!.body.body.includes("<b>Team"));
});
