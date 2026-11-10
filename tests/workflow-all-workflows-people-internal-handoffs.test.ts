// Internal handoffs workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp } from "../industries/all/workflows/people/internal-handoffs/index.ts";
import type { Handover, Settings } from "../industries/all/workflows/people/internal-handoffs/types.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/people/internal-handoffs";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const INTAKE = "1200000000000001", RECORD = "1200000000000002", CHANNEL = "C0123456789", DM = "D0AAAAAAA1";
const ME = "1111111111", OTHER = "2222222222", PERSON = "U0123456789";
const NOW = new Date("2026-11-08T00:00:00Z");
const HOUR = 36e5;

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let tasks: Record<string, { completed: boolean; stories: any[] }> = {};
let nextGid = 7001;
let slackMessages: any[] = [];
let dmFailures = 0; // how many direct-message opens fail before one works

const ASANA_TASK = { gid: "5001", name: "Quote for hot water at 1 Test St", notes: "Sam Lee wants a quote. <!channel> please check the site.", created_at: "2026-11-08T01:00:00Z" };
const SLACK_MSG = { type: "message", ts: "1731024000.000100", user: "U0999999999", text: "Install enquiry for Eva Chen at 2 Test St" };
const BOT_MSG = { type: "message", bot_id: "B0001", ts: "1731024200.000300", text: "Handovers open: 0" };

function fake() {
  hits = []; tasks = {}; nextGid = 7001; dmFailures = 0;
  slackMessages = [SLACK_MSG, BOT_MSG];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      // Asana (app.asana.com/api/1.0)
      if (p === `/api/1.0/projects/${INTAKE}/tasks` && m === "GET") return json({ data: [ASANA_TASK] });
      if (p === "/api/1.0/tasks" && m === "POST") { const gid = String(nextGid++); tasks[gid] = { completed: false, stories: [] }; return json({ data: { gid } }, 201); }
      const t = /^\/api\/1\.0\/tasks\/(\d+)(\/stories)?$/.exec(p);
      if (t) {
        const gid = t[1], rec = tasks[gid];
        if (!rec) return new Response("no such task", { status: 404 });
        if (!t[2] && m === "GET") return json({ data: { gid, completed: rec.completed, created_by: { gid: ME } } });
        if (!t[2] && m === "PUT") return json({ data: { gid } });
        if (t[2] && m === "GET") return json({ data: rec.stories });
        if (t[2] && m === "POST") { rec.stories.push({ resource_subtype: "comment_added", created_by: { gid: ME }, text: body?.data?.text }); return json({ data: { gid: "8" + gid } }, 201); }
      }
      // Slack (slack.com/api)
      if (p === "/api/conversations.history" && m === "GET") return json({ ok: true, messages: slackMessages });
      if (p === "/api/conversations.open" && m === "POST") {
        if (dmFailures > 0) { dmFailures--; return json({ ok: false, error: "internal_error" }); }
        return json({ ok: true, channel: { id: DM } });
      }
      if (p === "/api/chat.postMessage" && m === "POST") return json({ ok: true, ts: "1731024300.000400", channel: body?.channel });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

// Anything that notifies a person: an assignment, a note on a task, or a Slack message.
const mutations = () => hits.filter((h) => (h.method === "PUT" && /^\/api\/1\.0\/tasks\/\d+$/.test(h.path))
  || (h.method === "POST" && /^\/api\/1\.0\/tasks\/\d+\/stories$/.test(h.path)) || h.path === "/api/chat.postMessage");
const creates = () => hits.filter((h) => h.method === "POST" && h.path === "/api/1.0/tasks");
const storyPosts = () => hits.filter((h) => h.method === "POST" && /\/stories$/.test(h.path));

function settings(over: Partial<Settings> = {}): Settings {
  return {
    family: "all", business_name: "Test Build", signoff: "Operations team",
    asana: { intake_project_gid: INTAKE, record_project_gid: RECORD }, slack: { channel: CHANNEL },
    routes: [{ match: "quote", assignee: "estimator@example.com.au", slack_user: PERSON, due_days: 2 }],
    chase_after_hours: [24, 72], ...over,
  };
}
const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
const ctxAt = (store: MemoryStore, s: Settings, when = NOW) => context(WF, s, store, when, () => {});
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const handovers = async (store: MemoryStore) => Object.values(await store.list<Handover>("handovers"));
const find = (rows: Handover[], start: string) => rows.find((h) => h.title.startsWith(start))!;
const chases = (rows: Approval[]) => rows.filter((a) => a.id.includes("chase"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { ASANA_ACCESS_TOKEN: "at", SLACK_BOT_TOKEN: "xo", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot run as a draft, and a draft operation cannot be queued", async () => {
  const ctx = ctxAt(new MemoryStore(), settings());
  await assert.rejects(ctx.draft({ platform: "asana", op: "updateTask", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "slack", op: "chat_postMessage", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "asana", op: "createTask", summary: "x" }), /not a live operation/);
});

test("intake stores each request once, skips the bot's own posts, and moves the Slack cursor forward", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  const rows = await handovers(store);
  assert.deepEqual(rows.map((h) => h.platform).sort(), ["asana", "slack"]);
  assert.equal(rows.some((h) => h.title.startsWith("Handovers open")), false, "the bot's own post is not a request");
  const history = hits.filter((h) => h.path === "/api/conversations.history");
  assert.equal(history[0].query.get("oldest"), null, "the first read starts from the newest messages");
  assert.equal(history[1].query.get("oldest"), BOT_MSG.ts, "the second read starts after the newest message seen");
  assert.equal(creates().length + mutations().length, 0, "intake changes nothing outside the store");
});

test("draft records the routed request as an unassigned task, queues the handover, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 1, needs_routing: 1 });
  assert.equal(mutations().length, 0, "no assignment, note or message before approval");
  assert.equal(creates().length, 1, "one record task, for the request a route covers");
  const body = creates()[0].body.data;
  assert.equal(body.assignee, undefined, "the record task is created unassigned");
  assert.deepEqual(body.projects, [RECORD]);
  assert.match(body.name, /^Handover: Quote for hot water/);
  const rows = await handovers(store);
  assert.equal(find(rows, "Install").status, "needs-routing");
  assert.match(find(rows, "Install").reason ?? "", /no route matches/);
  assert.equal(find(rows, "Quote").status, "queued");
  assert.equal(find(rows, "Quote").route?.assignee, "estimator@example.com.au");
  const [ap] = await approvals(store);
  assert.deepEqual(ap.acts.map((a) => `${a.platform}.${a.op}`), ["asana.updateTask", "asana.createStoryForTask", "slack.chat_postMessage"]);
  assert.equal(ap.acts[0].input?.body?.data?.due_on, "2026-11-10", "due two days out");
  assert.equal(hits.filter((h) => h.path === "/api/conversations.open").length, 1, "one direct message opened for the routed person");
  const msg = ap.acts[2].input?.body;
  assert.equal(msg.channel, DM);
  assert.equal(msg.parse, "none");
  assert.match(msg.text, /&lt;!channel&gt;/, "Slack markup in the request is escaped");
  assert.doesNotMatch(msg.text, /<!channel>/);
});

test("re-runs never create a second record task or queue a second approval", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await draft(ctx), { queued: 0, needs_routing: 1 });
  await intake(ctx); await draft(ctx);
  assert.equal(creates().length, 1);
  assert.equal((await approvals(store)).length, 1);
});

test("a proposal from the agent routes the request that no route covers", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx); await draft(ctx);
  const install = find(await handovers(store), "Install");
  await store.put("proposals", install.id, { assignee: "ops@example.com.au", due_days: 3, summary: "Install at 2 Test St. Confirm the access time first." });
  assert.deepEqual(await draft(ctx), { queued: 1, needs_routing: 0 });
  assert.equal(creates().length, 2, "a record task for the proposed handover too");
  assert.deepEqual((await approvals(store)).map((a) => a.acts.length).sort(), [2, 3], "no Slack person, so no message for the install");
  assert.equal(mutations().length, 0);
});

test("a route with a bad assignee parks the request before any call is made", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings({ routes: [{ match: "quote", assignee: "not an email" }] }));
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 0, needs_routing: 2 });
  assert.equal(creates().length, 0);
  assert.equal(mutations().length, 0);
  assert.match(find(await handovers(store), "Quote").reason ?? "", /work email/);
});

test("approving the handover assigns the task, posts the note, and sends one escaped Slack message", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx); await draft(ctx);
  const [ap] = await approvals(store);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const put = hits.find((h) => h.method === "PUT" && h.path === "/api/1.0/tasks/7001")!;
  assert.deepEqual(put.body, { data: { assignee: "estimator@example.com.au", due_on: "2026-11-10" } });
  assert.equal(storyPosts().length, 1);
  assert.equal(hits.filter((h) => h.path === "/api/chat.postMessage").length, 1);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("follow-up marks the handover passed on, chases once after 24 hours, and stops when someone replies", async () => {
  const store = new MemoryStore();
  const first = ctxAt(store, settings());
  await intake(first); await draft(first);
  const [ap] = await approvals(store);
  await approve(WF, store, ap.id, "owner", NOW);

  assert.deepEqual(await followUp(ctxAt(store, settings(), at(1))), { passed: 1, chased: 0, acknowledged: 0, closed: 0, status_queued: true });
  assert.equal(chases(await approvals(store)).length, 0, "no chase before 24 hours");

  assert.equal((await followUp(ctxAt(store, settings(), at(25)))).chased, 1);
  assert.equal(chases(await approvals(store)).length, 1);
  assert.equal(storyPosts().length, 1, "the chase is queued, not posted");
  const afterFirstChase = (await approvals(store)).length;

  assert.equal((await followUp(ctxAt(store, settings(), at(26)))).chased, 0, "the second chase waits for 72 hours");
  assert.equal((await approvals(store)).length, afterFirstChase, "the same day's status post is not queued twice");

  tasks["7001"].stories.push({ resource_subtype: "comment_added", created_by: { gid: OTHER }, text: "On it" });
  assert.equal((await followUp(ctxAt(store, settings(), at(80)))).acknowledged, 1);
  assert.equal(find(await handovers(store), "Quote").status, "acknowledged");
  assert.equal(mutations().length, 3, "only the three approved acts ran (assign, note, message); no chase ran by itself");
});

test("a failed direct message does not lose the record task: the next run reuses it", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx);
  dmFailures = 1;
  assert.deepEqual(await draft(ctx), { queued: 0, needs_routing: 2 }, "the routed request parks when the direct message fails");
  assert.equal(creates().length, 1, "the routed request got its record task before the direct message failed");
  assert.deepEqual(await draft(ctx), { queued: 1, needs_routing: 1 });
  assert.equal(creates().length, 1, "the re-run reuses the saved record task and creates no more");
  assert.equal(find(await handovers(store), "Quote").status, "queued");
  assert.equal((await approvals(store)).length, 1);
});

test("a refused handover leaves the open list and is never retried or counted as open", async () => {
  const store = new MemoryStore(), ctx = ctxAt(store, settings());
  await intake(ctx); await draft(ctx);
  const [ap] = await approvals(store);
  await reject(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(await followUp(ctxAt(store, settings(), at(1))), { passed: 0, chased: 0, acknowledged: 0, closed: 0, status_queued: false });
  assert.equal(find(await handovers(store), "Quote").status, "rejected");
  assert.equal(mutations().length, 0, "nothing sent for a refused handover");
});
