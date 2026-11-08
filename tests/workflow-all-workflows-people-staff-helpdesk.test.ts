// Staff helpdesk workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, register } from "../industries/all/workflows/people/staff-helpdesk/index.ts";

const DIR = "industries/all/workflows/people/staff-helpdesk";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T02:00:00Z");
const MAILBOX = "helpdesk@example.com.au";
const SETTINGS: any = {
  business_name: "Test Co", intake: ["google-workspace", "slack"], sources: ["google-workspace", "slack"],
  google: { questions_query: "label:staff-questions is:unread", chat_space: "spaces/AAAA", log: { spreadsheet_id: "SHEET1234567890", range: "Questions!A:G" } },
  slack: { channel: "C0123456789" }, max_sources: 5,
};
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

const GMAIL_MSG = {
  id: "G1", threadId: "T1", internalDate: String(Date.parse("2026-11-08T01:00:00Z")), snippet: "Hi, where is the hot water SOP?",
  payload: {
    mimeType: "multipart/alternative",
    headers: [{ name: "From", value: "Sam Lee <sam@example.com>" }, { name: "Subject", value: "Where is the hot water SOP for callouts?" },
      { name: "Message-ID", value: "<abc123@mail.example.com>" }],
    parts: [{ mimeType: "text/plain", body: { data: b64("Hi, where is the hot water SOP for callouts?") } }],
  },
};
const CHAT_MSGS = [
  { name: "spaces/AAAA/messages/m1", text: "Where is the leave policy form?", sender: { type: "HUMAN", displayName: "Priya Shah" },
    createTime: "2026-11-08T01:30:00Z", thread: { name: "spaces/AAAA/threads/t1" } },
  { name: "spaces/AAAA/messages/m0", text: "Bot ping", sender: { type: "BOT" }, createTime: "2026-11-08T01:31:00Z" },
];
const DEFAULT_SLACK = [
  { type: "message", ts: "1762560100.000100", text: "Can someone share the leave policy?", user: "U1" },
  { type: "message", subtype: "channel_join", ts: "1762560090.000100", text: "joined" },
  { type: "message", ts: "1762560110.000100", text: "=cmd(1) where do I log an incident", user: "U2" },
];

type Hit = { method: string; url: URL; body: any };
let hits: Hit[] = [];
let noSources = false;
let slackMsgs: any[] = DEFAULT_SLACK.slice();

function fake() {
  hits = []; noSources = false; slackMsgs = DEFAULT_SLACK.slice();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, url: u, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/token") return json({ access_token: "tok", expires_in: 1800 });
      if (p === "/gmail/v1/users/me/messages" && m === "GET") return json({ messages: [{ id: "G1", threadId: "T1" }] });
      if (p === "/gmail/v1/users/me/messages/G1") return json(GMAIL_MSG);
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: "DRAFT1", message: { threadId: "T1" } });
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "SENT1", threadId: "T1" });
      if (p === "/v1/spaces/AAAA/messages" && m === "GET") return json({ messages: CHAT_MSGS });
      if (p === "/v1/spaces/AAAA/messages" && m === "POST") return json({ name: "spaces/AAAA/messages/NEW1" });
      if (p === "/drive/v3/files") return json({ files: noSources ? [] : [{ id: "DRIVE1", name: "Leave policy", mimeType: "application/vnd.google-apps.document" }] });
      if (p.endsWith(":append")) return json({ updates: { updatedRows: 1 } });
      if (p.endsWith("/conversations.history")) return json({ ok: true, messages: slackMsgs });
      if (p.endsWith("/search.files")) return json({ ok: true, files: { matches: noSources ? [] : [{ id: "F1", name: "Leave policy 2026", permalink: "https://example.slack.com/files/F1" }] } });
      if (p.endsWith("/chat.postMessage")) return json({ ok: true, ts: "1762560200.000100" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const idOf = (qs: Record<string, any>, pred: (q: any) => boolean): string => {
  const hit = Object.values(qs).find(pred);
  assert.ok(hit, "question not found");
  return hit.id as string;
};
const isSend = (h: Hit) => h.url.pathname.endsWith("/drafts/send") || h.url.pathname.endsWith("/chat.postMessage")
  || (h.method === "POST" && /^\/v1\/spaces\/AAAA\/messages$/.test(h.url.pathname));

beforeEach(async () => {
  fake();
  const tokens = new MemoryTokenStore();
  setTokenStore(tokens);
  await tokens.set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { KIT_ALLOW_WRITES: "1", GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec",
    SLACK_BOT_TOKEN: "xoxb-test", SLACK_USER_TOKEN: "xoxp-test" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x", input: { params: { userId: "me" }, body: { id: "D" } } }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "slack", op: "chat_postMessage", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.drafts.create", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("intake reads Gmail, Chat and Slack questions once, and only reads", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 4 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.ok(hits.every((h) => h.method === "GET" || h.url.pathname === "/token"));
  const qs = Object.values(await store.list<any>("questions"));
  assert.deepEqual(qs.map((q) => q.source).sort(), ["google-workspace", "google-workspace", "slack", "slack"]);
});

test("draft parks a question with no written answer and sends nothing", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await draft(ctx);
  const qs = Object.values(await store.list<any>("questions"));
  assert.ok(qs.every((q) => q.status === "needs-answer" && q.sources.length >= 1));
  assert.equal(hits.filter((h) => h.method === "POST" && h.url.pathname !== "/token").length, 0);
  assert.deepEqual(await store.list("approvals"), {});
});

test("a question with no matching SOP is parked for a person, not guessed at", async () => {
  noSources = true;
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await draft(ctx);
  const qs = Object.values(await store.list<any>("questions"));
  assert.ok(qs.every((q) => q.status === "needs-answer" && q.sources.length === 0 && /a person needs to answer/.test(q.reason)));
});

test("Drive and Slack searches send only plain words, even from a hostile question", async () => {
  slackMsgs = [{ type: "message", ts: "1762560120.000100", text: "Robert'); DROP TABLE policies; -- leave policy", user: "U3" }];
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await draft(ctx);
  const drive = hits.find((h) => h.url.pathname === "/drive/v3/files");
  assert.ok(drive, "Drive was searched");
  assert.match(drive.url.searchParams.get("q") ?? "", /^\(fullText contains '[a-z]+'( or fullText contains '[a-z]+')*\) and trashed = false$/);
  const slack = hits.find((h) => h.url.pathname.endsWith("/search.files"));
  assert.match(slack?.url.searchParams.get("query") ?? "", /^[a-z]+( OR [a-z]+)*$/);
});

test("an answered Gmail question is drafted in its thread, queued, and sent only on approval", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("answers", idOf(await store.list("questions"), (q: any) => q.thread.gmail_thread === "T1"),
    { text: "The hot water SOP is in the Callouts folder." });
  await draft(ctx);

  const creates = hits.filter((h) => h.method === "POST" && h.url.pathname === "/gmail/v1/users/me/drafts");
  assert.equal(creates.length, 1);
  const mime = Buffer.from(creates[0].body.message.raw, "base64url").toString("utf8");
  assert.match(mime, /^To: sam@example\.com\r\n/);
  assert.match(mime, /In-Reply-To: <abc123@mail\.example\.com>/);
  assert.equal(creates[0].body.message.threadId, "T1");
  assert.equal(hits.filter((h) => h.url.pathname.endsWith("/drafts/send")).length, 0);

  const apps = Object.values(await store.list<Approval>("approvals"));
  const mine = apps.filter((a) => a.summary.startsWith("Reply to Sam Lee"));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "pending");

  await draft(ctx); // a second run never drafts or queues it again
  assert.equal(hits.filter((h) => h.method === "POST" && h.url.pathname === "/gmail/v1/users/me/drafts").length, 1);
  assert.equal(Object.values(await store.list<Approval>("approvals")).filter((a) => a.summary.startsWith("Reply to Sam Lee")).length, 1);

  const done = await approve(WF, store, mine[0].id, "oscar", NOW);
  assert.equal(done.status, "done");
  const sent = hits.filter((h) => h.url.pathname === "/gmail/v1/users/me/drafts/send");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { id: "DRAFT1" });
  await assert.rejects(approve(WF, store, mine[0].id, "oscar", NOW), /already done/);
});

test("an answered Chat question is queued as a threaded Chat reply and posted only on approval", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("answers", idOf(await store.list("questions"), (q: any) => q.thread.chat_space === "spaces/AAAA"),
    { text: "The leave form is in the HR folder." });
  await draft(ctx);
  assert.equal(hits.filter(isSend).length, 0);
  const ap = Object.values(await store.list<Approval>("approvals")).find((a) => a.summary.startsWith("Reply to Priya Shah"));
  assert.ok(ap);
  await approve(WF, store, ap.id, "oscar", NOW);
  const post = hits.find((h) => h.method === "POST" && h.url.pathname === "/v1/spaces/AAAA/messages");
  assert.ok(post);
  assert.equal(post.url.searchParams.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  assert.equal(post.body.thread.name, "spaces/AAAA/threads/t1");
  assert.equal(post.body.text, "The leave form is in the HR folder.");
});

test("an answered Slack question is queued as a thread reply, escaped, and posted only on approval", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await store.put("answers", idOf(await store.list("questions"), (q: any) => q.text === "Can someone share the leave policy?"),
    { text: "Use the form <b> from the HR folder." });
  await draft(ctx);
  assert.equal(hits.filter((h) => h.url.pathname.endsWith("/chat.postMessage")).length, 0);
  const ap = Object.values(await store.list<Approval>("approvals")).find((a) => a.summary.includes("Can someone share"));
  assert.ok(ap);
  await approve(WF, store, ap.id, "oscar", NOW);
  const post = hits.find((h) => h.url.pathname.endsWith("/chat.postMessage"));
  assert.ok(post);
  assert.equal(post.body.channel, "C0123456789");
  assert.equal(post.body.thread_ts, "1762560100.000100");
  assert.equal(post.body.text, "Use the form &lt;b&gt; from the HR folder.");
});

test("no cron sends: with an answer for every question, the crons only draft and queue", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  for (const q of Object.values(await store.list<any>("questions"))) await store.put("answers", q.id, { text: "Answer for this question." });
  await draft(ctx);
  await register(ctx);
  assert.equal(hits.filter(isSend).length, 0);
  assert.equal(Object.keys(await store.list("approvals")).length, 4);
  assert.ok(Object.values(await store.list<any>("questions")).every((q) => q.status === "drafted"));
});

test("register appends one escaped row per question to the register Sheet, once", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  await draft(ctx);
  assert.deepEqual(await register(ctx), { logged: 4 });
  const rows = hits.filter((h) => h.url.pathname.endsWith(":append"));
  assert.equal(rows.length, 4);
  const cells: string[] = rows.flatMap((h) => h.body.values.flat());
  assert.ok(cells.includes("'=cmd(1) where do I log an incident"));
  assert.ok(!cells.some((c) => /^[=+\-@]/.test(c)), "no cell can start a formula");
  assert.deepEqual(await register(ctx), { logged: 0 });
  assert.equal(hits.filter((h) => h.url.pathname.endsWith(":append")).length, 4);
});
