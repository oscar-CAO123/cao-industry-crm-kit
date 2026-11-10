// SOPs and training workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, train } from "../industries/all/workflows/people/sops-training/index.ts";
import { main } from "../tools/workflow.ts";
import { microsoft365 } from "../industries/all/workflows/people/sops-training/adapters/microsoft-365.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/people/sops-training";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const PROJECT = "1200000000000001", TRAINEE = "jordan@example.com.au";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
const WALK = { id: "AAMkWalk1", subject: "Walkthrough: hot water", receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Recording is in the link below." };
let mailRows: any[] = [WALK];

function fake() {
  hits = []; mailRows = [WALK];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      // Confluence (acme.atlassian.net)
      if (p === "/wiki/api/v2/pages" && m === "GET") return json({ results: [{ id: "111", title: "Hot water safety", createdAt: "2026-11-01T00:00:00Z", body: { storage: { value: "<p>Isolate the <b>valve</b> first.</p>" } } }] });
      if (p === "/wiki/api/v2/pages" && m === "POST") return json({ id: "222", status: "draft", version: { number: 1 } });
      if (p === "/wiki/api/v2/pages/222" && m === "PUT") return json({ id: "222", status: "current", version: { number: 2 } });
      // Microsoft Graph
      if (p.endsWith("/messages") && m === "GET") return json({ value: mailRows });
      if (p.endsWith("/messages") && m === "POST") return json({ id: "AAMkDraft1" }, 201);
      if (/\/messages\/AAMkDraft1\/send$/.test(p)) return new Response(null, { status: 202 });
      // Asana (app.asana.com/api/1.0)
      if (p === "/api/1.0/tasks" && m === "POST") return json({ data: { gid: "9001" } }, 201);
      if (p === "/api/1.0/tasks/9001" && m === "PUT") return json({ data: { gid: "9001" } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const count = (method: string, path: RegExp) => hits.filter((h) => h.method === method && path.test(h.path)).length;
const SET: any = {
  family: "all", business_name: "Test Trades", signoff: "Operations team",
  know_how: ["confluence", "microsoft-365"],
  confluence: { source_space_id: "123456", sop_space_id: "234567" },
  microsoft_365: { mailbox: "training@example.com.au", folder: "Walkthroughs", search: "walkthrough" },
  asana: { project_gid: PROJECT },
  trainees: [{ name: "Jordan Example", email: TRAINEE }],
};
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { CONFLUENCE_EMAIL: "ops@example.com.au", CONFLUENCE_API_TOKEN: "ct", CONFLUENCE_SITE: "acme.atlassian.net",
    ASANA_ACCESS_TOKEN: "at", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot run as a draft, and a draft operation cannot be queued as live", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "confluence", op: "openapi-v2-v3.updatePage", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "confluence", op: "openapi-v2-v3.createPage", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "asana", op: "updateTask", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "asana", op: "createTask", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "nothing reached the network");
});

test("crons never publish or send: a source is drafted as a page and its publish waits for approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_writing: 2 }, "no outline yet, so nothing is drafted");
  assert.equal(count("POST", /\/pages$/), 0);

  const src = Object.values(await store.list<any>("sources")).find((s) => s.platform === "confluence")!;
  await store.put("proposals", src.id, { title: "Hot water safety", purpose: "Keep staff safe on hot water jobs.",
    steps: ["Isolate the valve <b>first</b>", "Check pressure & log it"] });
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_writing: 1 });
  const page = hits.find((h) => h.method === "POST" && h.path === "/wiki/api/v2/pages")!.body;
  assert.equal(page.status, "draft");
  assert.equal(page.spaceId, "234567");
  assert.equal(page.title, "SOP: Hot water safety");
  assert.match(page.body.value, /Isolate the valve &lt;b&gt;first&lt;\/b&gt;/, "outline text is escaped");
  assert.match(page.body.value, /Check pressure &amp; log it/);
  assert.equal(count("PUT", /\/pages\//), 0, "not published by the cron");
  assert.equal(sends().length, 0, "nothing sent");

  const pending = await main(["approvals", DIR], store) as any[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  const ap = await store.get<Approval>("approvals", pending[0].id);
  assert.deepEqual(ap!.acts.map((a) => a.op), ["openapi-v2-v3.updatePage"]);
  const walk = Object.values(await store.list<any>("sources")).find((s) => s.platform === "microsoft-365");
  assert.equal(walk.status, "needs-writing");
  assert.match(walk.reason, /no SOP outline/);
  const page2 = Object.values(await store.list<any>("sources")).find((s) => s.id === src.id);
  assert.equal(page2.text, "Isolate the valve first.", "know-how text is stripped of tags before it is stored");
});

test("re-runs never create a second draft page or queue a second publish", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  const src = Object.values(await store.list<any>("sources")).find((s) => s.platform === "confluence")!;
  await store.put("proposals", src.id, { title: "Hot water safety", steps: ["Isolate the valve"] });
  await draft(ctx);
  assert.deepEqual(await intake(ctx), { added: 0 });
  await draft(ctx);
  assert.equal(count("POST", /\/pages$/), 1);
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 1);
});

test("an unusable outline stays parked with its reason, and nothing is created for it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  const src = Object.values(await store.list<any>("sources")).find((s) => s.platform === "confluence")!;
  await store.put("proposals", src.id, { title: "Hot water safety", steps: [] });
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_writing: 2 });
  const parked = await store.get<any>("sources", src.id);
  assert.equal(parked.status, "needs-writing");
  assert.match(parked.reason, /1 to 40 steps/);
  assert.equal(count("POST", /\/pages$/), 0);
});

test("an approved publish runs once; then each trainee gets one task and one approval that assigns it and sends the email", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  const src = Object.values(await store.list<any>("sources")).find((s) => s.platform === "confluence")!;
  await store.put("proposals", src.id, { title: "Hot water safety", steps: ["Isolate the valve", "Check pressure"] });
  await draft(ctx);
  const [publish] = await main(["approvals", DIR], store) as any[];
  assert.equal(await train(context(WF, SET, store, NOW, () => {})).then((r: any) => r.queued), 0, "no train before the publish is approved");
  assert.equal((await approve(WF, store, publish.id, "owner", NOW)).status, "done");
  assert.equal(count("PUT", /\/pages\/222$/), 1);
  const pub = hits.find((h) => h.method === "PUT")!.body;
  assert.equal(pub.status, "current");
  assert.equal(pub.version.number, 1);

  assert.deepEqual(await train(context(WF, SET, store, NOW, () => {})), { published: 1, queued: 1, no_address: 0 });
  const task = hits.find((h) => h.method === "POST" && h.path === "/api/1.0/tasks")!.body.data;
  assert.deepEqual(task.projects, [PROJECT]);
  assert.match(task.notes, /1\. Isolate the valve\n2\. Check pressure/);
  assert.equal(count("POST", /\/messages$/), 1, "one email draft");
  assert.equal(sends().length, 0, "queued, not sent");
  assert.deepEqual(await train(context(WF, SET, store, NOW, () => {})), { published: 0, queued: 0, no_address: 0 }, "never twice");
  assert.equal(count("POST", /\/tasks$/), 1);

  const [trainApproval] = (await main(["approvals", DIR], store) as any[]);
  const full = await store.get<Approval>("approvals", trainApproval.id);
  assert.deepEqual(full!.acts.map((a) => a.op), ["updateTask", "users.user.messages.message.send"]);
  assert.equal((await approve(WF, store, trainApproval.id, "owner", NOW)).status, "done");
  assert.equal(hits.find((h) => h.method === "PUT" && h.path === "/api/1.0/tasks/9001")!.body.data.assignee, TRAINEE);
  assert.equal(sends().length, 1, "the training email went once");
  await assert.rejects(approve(WF, store, trainApproval.id, "owner", NOW), /already done/);
});

test("walkthrough mail is read only from a named folder: the inbox and an unset folder are refused before any read", async () => {
  for (const folder of [undefined, "Inbox"]) {
    const store = new MemoryStore();
    const set = { ...SET, microsoft_365: { mailbox: "training@example.com.au", search: "walkthrough", ...(folder ? { folder } : {}) } };
    await assert.rejects(intake(context(WF, set, store, NOW, () => {})), /walkthrough folder/);
    assert.equal(hits.filter((h) => h.method === "GET" && h.path.endsWith("/messages")).length, 0, "no mail was read");
  }
});

test("walkthrough message ids '.' and '..' are path segments and are dropped, not read", async () => {
  mailRows = [{ id: "..", subject: "Walkthrough: bad" }, { id: ".", subject: "Walkthrough: bad" }, WALK];
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  const rows = await microsoft365.sources(ctx);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ref, { message_id: WALK.id });
});

test("the publish approval shows the source text beside the draft", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  const src = Object.values(await store.list<any>("sources")).find((s) => s.platform === "confluence")!;
  await store.put("proposals", src.id, { title: "Hot water safety", steps: ["Isolate the valve"] });
  await draft(ctx);
  const sop = (await store.get<any>("sources", src.id)).sop;
  const ap = await store.get<Approval>("approvals", sop.approval);
  assert.match(ap!.summary, /Source text: Isolate the valve first\./);
  assert.match(ap!.summary, /Hot water safety/);
});
