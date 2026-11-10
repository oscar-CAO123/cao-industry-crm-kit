// Calls workflow tests (real estate sales). Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { callSync, callDraft, followUp } from "../industries/real-estate/workflows/sales/calls/index.ts";
import type { CallLead } from "../industries/real-estate/workflows/sales/calls/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/calls/workflow.json", "utf8")) as WorkflowRecord;
const BOX = "sales@example.com.au", MSG = "AAMkDraft1";
const NOW = new Date("2026-11-09T00:00:00Z");
const DAY = 864e5;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let contacts: any[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/contacts" && m === "GET") return json({ pageNumber: 1, pageCount: contacts.length, totalPageCount: 1, _embedded: contacts });
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: MSG });
      if (/\/messages\/[^/]+\/send$/.test(p) && m === "POST") return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const CONTACT = (id: string, forename = "Ari", extra: object = {}) =>
  ({ id, forename, surname: "Lee", email: "ari@example.com", mobilePhone: "0412 345 678", modified: "2026-11-01T00:00:00Z", ...extra });
const SET: any = { business_name: "Test Realty", microsoft_365: { mailbox: BOX }, first_call_text: "Hi {name}, thanks for getting in touch. Can we talk this week?", follow_up: { after_days: [3, 7] } };
const run = (store: MemoryStore, ms = 0, settings: any = SET) => context(WF, settings, store, new Date(NOW.getTime() + ms), () => {});
async function setStatus(store: MemoryStore, id: string, status: CallLead["status"]) {
  const l = await store.get<CallLead>("call-leads", id);
  await store.put("call-leads", id, { ...l!, status });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  contacts = [CONTACT("OXF18000001")];
  Object.assign(process.env, { REAPIT_ACCESS_TOKEN: "rt", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot send as a draft, and cannot queue a draft as live", async () => {
  const ctx = run(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "agentbox", op: "get:/contact/{id}", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
  assert.equal(sends().length, 0);
});

test("call-sync adds each valid contact as new, skips a bad id, and never touches Outlook", async () => {
  contacts = [CONTACT("OXF18000001"), CONTACT("bad id!")];
  const store = new MemoryStore();
  assert.deepEqual(await callSync(run(store)), { seen: 1, added: 1, updated: 0 });
  assert.equal(Object.keys(await store.list("call-leads")).length, 1);
  const l = await store.get<CallLead>("call-leads", "OXF18000001");
  assert.equal(l?.status, "new");
  assert.equal(l?.email, "ari@example.com");
  assert.equal(hits.filter((h) => h.path.includes("/users/")).length, 0);
  // a second run adds nothing and keeps a status a person has set
  await setStatus(store, "OXF18000001", "to-contact");
  assert.deepEqual(await callSync(run(store)), { seen: 1, added: 0, updated: 0 });
  assert.equal((await store.get<CallLead>("call-leads", "OXF18000001"))?.status, "to-contact");
});

test("call-draft drafts only leads marked to-contact, queues one approval, and never sends", async () => {
  const store = new MemoryStore();
  await callSync(run(store));
  assert.deepEqual(await callDraft(run(store)), { queued: 0, no_email: 0 }, "nothing is drafted until a person marks the contact");
  assert.equal(drafts().length, 0);
  await setStatus(store, "OXF18000001", "to-contact");
  assert.deepEqual(await callDraft(run(store)), { queued: 1, no_email: 0 });
  const d = drafts()[0].body;
  assert.equal(d.toRecipients[0].emailAddress.address, "ari@example.com");
  assert.equal(d.subject, "A quick call about your property");
  assert.match(d.body.content, /Hi Ari, thanks for getting in touch/);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.equal(aps[0].status, "pending");
  // re-runs neither draft nor queue the same contact again
  assert.deepEqual(await callDraft(run(store)), { queued: 0, no_email: 0 });
  await callSync(run(store));
  assert.equal(drafts().length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("a contact with no valid email is marked no-email and never drafted", async () => {
  contacts = [CONTACT("OXF18000002", "Sam", { email: "not-an-email" })];
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000002", "to-contact");
  assert.deepEqual(await callDraft(run(store)), { queued: 0, no_email: 1 });
  assert.equal(drafts().length, 0);
  assert.equal((await store.get<CallLead>("call-leads", "OXF18000002"))?.status, "no-email");
});

test("names are escaped in the email body", async () => {
  contacts = [CONTACT("OXF18000003", "<img src=x onerror=1>")];
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000003", "to-contact");
  await callDraft(run(store));
  const content = drafts()[0].body.body.content as string;
  assert.match(content, /&lt;img/);
  assert.doesNotMatch(content, /<img/);
});

test("the send runs only when a person approves it, and never twice", async () => {
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000001", "to-contact");
  await callDraft(run(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(sends().length, 0);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${MSG}/send$`));
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
});

test("a chaser is queued once each set number of days has passed after an approved first call", async () => {
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000001", "to-contact");
  await callDraft(run(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(await followUp(run(store, 0)), { sent: 1, queued: 0 });
  assert.deepEqual(await followUp(run(store, 2 * DAY)), { sent: 0, queued: 0 });
  assert.deepEqual(await followUp(run(store, 4 * DAY)), { sent: 0, queued: 1 });
  assert.deepEqual(await followUp(run(store, 5 * DAY)), { sent: 0, queued: 0 });
  assert.deepEqual(await followUp(run(store, 8 * DAY)), { sent: 0, queued: 1 });
  assert.deepEqual(await followUp(run(store, 9 * DAY)), { sent: 0, queued: 0 });
  assert.equal(drafts().length, 3, "one first call and two chasers drafted");
  assert.equal(sends().length, 1, "only the approved first call was sent; the chasers are queued, not sent");
  assert.equal(Object.keys(await store.list("approvals")).length, 3);
});

test("a rejected first call is queued again once a person sends the contact back to to-contact, then sent", async () => {
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000001", "to-contact");
  await callDraft(run(store));
  const [first] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, first.id, "owner", NOW);
  await setStatus(store, "OXF18000001", "to-contact");
  assert.deepEqual(await callDraft(run(store)), { queued: 1, no_email: 0 });
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "one new pending send");
  assert.notEqual(pending[0].id, first.id);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(await approve(WF, store, pending[0].id, "owner", NOW).then((a) => a.status), "done");
  assert.equal(sends().length, 1);
  assert.deepEqual(await followUp(run(store, 0)), { sent: 1, queued: 0 });
});

test("a draft id made only of dots is refused before any send path is built", async () => {
  const store = new MemoryStore();
  await callSync(run(store));
  await setStatus(store, "OXF18000001", "to-contact");
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      hits.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: undefined });
      return new Response(JSON.stringify({ id: ".." }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
  });
  await assert.rejects(callDraft(run(store)), /draft not created/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal(sends().length, 0);
});
