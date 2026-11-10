// Check-in, renewal and win-back workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { dueList, draft, replies } from "../industries/all/workflows/customer-success/checkins-winback/index.ts";
import { checkSettings, type Settings } from "../industries/all/workflows/customer-success/checkins-winback/types.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/customer-success/checkins-winback";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const DAYS = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const LIST = "abc123def4", CAMP = "camp1a2b3c", CONV = "conv1a2b3c";
const HASH_DUE = md5("due@example.com"), HASH_NOT = md5("recent@example.com"), HASH_REPLY = md5("reply@example.com");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failContent = 0; // when set, the campaign body write answers with this status

function fake() {
  hits = []; failContent = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `/3.0/lists/${LIST}/members` && m === "GET") {
        // Three subscribers: one due (tagged, unchanged 120 days), one tagged but recent, one untagged and old.
        return json({ total_items: 3, members: [
          { id: HASH_DUE, tags: [{ id: 1, name: "lapsed-90-days" }], last_changed: DAYS(120) },
          { id: HASH_NOT, tags: [{ id: 1, name: "lapsed-90-days" }], last_changed: DAYS(10) },
          { id: md5("untagged@example.com"), tags: [], last_changed: DAYS(400) },
        ] });
      }
      if (p === "/3.0/conversations" && m === "GET") {
        return json({ total_items: 2, conversations: [
          { id: CONV, campaign_id: CAMP, message_count: 2, from_email: "reply@example.com", unread_messages: 1 },
          { id: "conv9z8y7x", message_count: 1, from_email: "other@example.com", unread_messages: 1 },
        ] });
      }
      if (p === "/3.0/campaigns" && m === "POST") return json({ id: CAMP, type: "regular", status: "save" });
      if (p === `/3.0/campaigns/${CAMP}/content` && m === "PUT") {
        if (failContent) return new Response("down", { status: failContent });
        return json({ html: body?.html });
      }
      if (p === `/3.0/campaigns/${CAMP}/actions/send` && m === "POST") return new Response(null, { status: 204 });
      if (p === `/3.0/lists/${LIST}/members/${HASH_REPLY}/notes` && m === "POST") return json({ note: body?.note });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: Settings = {
  business_name: "Test Studio", from_name: "Test Studio", reply_to: "hello@example.com", mailchimp: { list_id: LIST },
  groups: [{ name: "lapsed-90-days", tag: "lapsed-90-days", segment_id: 555, after_days: 90, subject: "Checking in", html: "<p>Hi, checking in.</p>" }],
};
const sends = () => hits.filter((h) => h.path.endsWith("/actions/send"));
const creates = () => hits.filter((h) => h.path === "/3.0/campaigns" && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { MAILCHIMP_API_KEY: "k", MAILCHIMP_DC: "us1", KIT_ALLOW_WRITES: "1" });
});

test("crons read and draft; the send is only queued, never run", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await dueList(ctx), { subscribed: 3, due: { "lapsed-90-days": 1 } });
  assert.deepEqual(await draft(ctx), { drafted: 1, skipped: 0 });
  assert.equal(creates().length, 1, "one draft campaign");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.deepEqual(approvals[0].acts.map((a) => [a.op, a.input]), [["core.campaigns_create-action-send", { params: { campaign_id: CAMP } }]]);
});

test("re-runs never draft or queue the same group twice on the same day", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await dueList(ctx); await draft(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, skipped: 1 });
  await dueList(ctx); await draft(ctx);
  assert.equal(creates().length, 1);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
});

test("an approved send runs once, and a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await dueList(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("a reply is noted once per conversation, and only for a campaign conversation", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await replies(ctx), { noted: 1, skipped: 0 });
  const notes = hits.filter((h) => h.path.endsWith("/notes"));
  assert.equal(notes.length, 1);
  assert.match(notes[0].body.note, /A person needs to answer/);
  assert.deepEqual(await replies(ctx), { noted: 0, skipped: 1 });
  assert.equal(hits.filter((h) => h.path.endsWith("/notes")).length, 1, "noted once");
});

test("a draft cannot run a live operation, and a queue cannot take a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "mailchimp", op: "core.campaigns_create-action-send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "mailchimp", op: "core.campaigns_create", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("settings with an unchecked list id or address stop before any network call", () => {
  assert.throws(() => checkSettings({ ...SETTINGS, mailchimp: { list_id: "abc/../x" } }), /list id/);
  assert.throws(() => checkSettings({ ...SETTINGS, reply_to: "not an address" }), /reply_to/);
  assert.throws(() => checkSettings({ ...SETTINGS, groups: [{ ...SETTINGS.groups[0], name: "../../etc" }] }), /group name/);
  assert.equal(hits.length, 0);
});

test("the approver is told which saved segment sets the recipients, not just the due count", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await dueList(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /saved segment 555/);
  assert.match(ap.summary, /sets the recipients, not the due list/);
  assert.doesNotMatch(ap.summary, /\(1 due at the last check\)/);
});

test("a run that fails while setting the body resumes the same campaign on the next run, and queues one send", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await dueList(ctx);
  failContent = 503;
  await assert.rejects(draft(ctx), /status 503/);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0, "nothing queued by the failed run");
  failContent = 0;
  assert.deepEqual(await draft(ctx), { drafted: 1, skipped: 0 }, "the next run does not skip the group");
  assert.equal(creates().length, 1, "still one campaign: the run resumed, it did not draft again");
  assert.equal(hits.filter((h) => h.path === `/3.0/campaigns/${CAMP}/content` && h.method === "PUT").length, 2, "body set on each try, then left alone");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].input?.params?.campaign_id, CAMP);
  assert.deepEqual(await draft(ctx), { drafted: 0, skipped: 1 }, "a later run finds it queued and does nothing");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});
