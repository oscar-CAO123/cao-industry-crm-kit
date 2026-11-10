// Hiring workflow tests. Every request goes to a fake network: no test reaches a real mailbox or workbook.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import fs from "node:fs";
import { intake, draft } from "../industries/all/workflows/people/hiring/index.ts";
import type { Settings, Applicant } from "../industries/all/workflows/people/hiring/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/people/hiring/workflow.json", "utf8")) as WorkflowRecord;
const BOX = "careers@example.com";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let inbox: any[] = [];
let draftN = 0;

function fake() {
  hits = []; draftN = 0;
  inbox = [{ id: "AAMkApp1", subject: "Application: AI Officer", from: { emailAddress: { name: "Ari Chen", address: "ari@example.com" } },
    receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Ten years in operations, keen to build AI workflows." }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: `AAMkDraft${++draftN}` });
      if (p.endsWith("/messages")) return json({ value: inbox });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");
const rows = () => hits.filter((h) => h.path.endsWith("/rows") && h.method === "POST");
const S: Settings = { business_name: "Test Pty Ltd", signoff: "Priya, Test Pty Ltd",
  microsoft_365: { mailbox: BOX, search: "application", register: { drive: "D1", item: "I1", table: "T1" } } };
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("intake: an application becomes one register row and one stored applicant, never sent; a re-run adds nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.equal(rows().length, 1);
  assert.deepEqual(rows()[0].body.values[0].slice(1), ["Ari Chen", "ari@example.com", "AI Officer", "microsoft-365", "New"]);
  const [a] = Object.values(await store.list<Applicant>("applicants"));
  assert.equal(a.stage, "new");
  assert.equal(a.role, "AI Officer");
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(rows().length, 1, "the register is not written twice");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("draft: a new applicant gets one Outlook draft and one queued send; a re-run queues nothing more", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 1, no_address: 0 });
  assert.equal(drafts().length, 1);
  assert.equal(drafts()[0].body.toRecipients[0].emailAddress.address, "ari@example.com");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.deepEqual(await draft(ctx), { queued: 0, no_address: 0 });
  assert.equal(drafts().length, 1, "no second draft on a re-run");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].acts.map((x) => x.op), ["users.user.messages.message.send"]);
});

test("approving the acknowledgement sends it once; a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/messages\/AAMkDraft1\/send$/);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("the owner's decision queues one interview invitation, once; a decline is drafted the same way", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [a] = Object.values(await store.list<Applicant>("applicants"));
  await store.put("applicants", a.id, { ...a, decision: "interview" });
  assert.deepEqual(await draft(ctx), { queued: 1, no_address: 0 });
  const invite = drafts().at(-1)!.body;
  assert.match(invite.subject, /Next step/);
  assert.equal(sends().length, 0);
  assert.deepEqual(await draft(ctx), { queued: 0, no_address: 0 }, "one invitation, not two");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2, "acknowledgement and invitation only");

  const s2 = new MemoryStore(), c2 = context(WF, S, s2, NOW, () => {});
  await intake(c2); await draft(c2);
  const [b] = Object.values(await s2.list<Applicant>("applicants"));
  await s2.put("applicants", b.id, { ...b, decision: "decline" });
  assert.deepEqual(await draft(c2), { queued: 1, no_address: 0 });
  assert.match(drafts().at(-1)!.body.body.content, /not to go ahead/);
});

test("an applicant with no address is counted for a person, not drafted", async () => {
  inbox[0].from = { emailAddress: { name: "No Address", address: "not-an-address" } };
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 0, no_address: 1 });
  assert.equal(drafts().length, 0);
});

test("text from an applicant is escaped in the email, and a register cell cannot become a formula", async () => {
  inbox[0].from = { emailAddress: { name: "<b>Ari</b> Chen", address: "ari@example.com" } };
  inbox[0].subject = "Application: =HYPERLINK(\"x\")";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const html = drafts()[0].body.body.content as string;
  assert.ok(html.includes("&lt;b&gt;"), "name escaped");
  assert.ok(!html.includes("<b>Ari"), "no raw markup");
  assert.equal(rows()[0].body.values[0][3], "'=HYPERLINK(\"x\")");
});

test("a missing mailbox stops the crons with a clear error and writes nothing", async () => {
  const ctx = context(WF, { ...S, microsoft_365: { mailbox: "" } as any }, new MemoryStore(), NOW, () => {});
  await assert.rejects(intake(ctx), /microsoft_365\.mailbox/);
  assert.equal(hits.length, 0);
});
