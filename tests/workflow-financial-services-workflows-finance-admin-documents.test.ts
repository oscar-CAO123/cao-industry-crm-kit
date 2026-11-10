// Forms-typed-by-hand workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { clearTokenCache, refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { intake, draft, followUp } from "../industries/financial-services/workflows/finance-admin/documents/index.ts";
import type { Settings, Submission } from "../industries/financial-services/workflows/finance-admin/documents/types.ts";
import fs from "node:fs";

const DIR = "industries/financial-services/workflows/finance-admin/documents";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com.au";
const NOW = new Date("2026-11-09T00:00:00Z");
const DAY = 864e5;

const SET: Settings = {
  family: "matter-intake",
  business_name: "Test Finance",
  forms: [{ form_id: "FORM1", label: "Loan application", fields: [
    { question_id: "QA", label: "Full name", required: true },
    { question_id: "QB", label: "Loan amount", required: true },
    { question_id: "QC", label: "Notes" },
  ] }],
  chase: { after_days: [3, 7] },
};

const answer = (v: string) => ({ textAnswers: { answers: [{ value: v }] } });
const RESPONSES = [
  // complete, with an email
  { responseId: "R1", lastSubmittedTime: "2026-11-08T01:00:00Z", respondentEmail: "ari@example.com",
    answers: { QA: answer("Ari Patel"), QB: answer("450000") } },
  // missing the loan amount, with an email
  { responseId: "R2", lastSubmittedTime: "2026-11-08T02:00:00Z", respondentEmail: "sam@example.com",
    answers: { QA: answer("Sam Lee") } },
  // missing the loan amount, no email collected
  { responseId: "R3", lastSubmittedTime: "2026-11-08T03:00:00Z", answers: { QA: answer("Jo Kim") } },
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let drafts = 0;
let responses = RESPONSES.map((r) => ({ ...r }));

function fake() {
  hits = []; drafts = 0; responses = RESPONSES.map((r) => ({ ...r }));
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "tok", expires_in: 1800 });
      if (p === "/v1/forms/FORM1/responses") return json({ responses });
      const one = /^\/v1\/forms\/FORM1\/responses\/(R\d)$/.exec(p);
      if (m === "GET" && one) return json(responses.find((r) => r.responseId === one[1]) ?? {});
      if (p === `/gmail/v1/users/me/drafts` && m === "POST") { drafts++; return json({ id: `DRAFT${drafts}` }); }
      if (p.endsWith("/drafts/send")) return json({ id: "SENT" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/drafts/send"));
const draftsMade = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST");
const subs = async (store: MemoryStore) => Object.values(await store.list<Submission>("submissions"));
const bySender = async (store: MemoryStore, email: string) => (await subs(store)).find((s) => s.email === email)!;

beforeEach(async () => {
  fake();
  clearTokenCache();
  const tokens = new MemoryTokenStore();
  await tokens.set(refreshKey(MAILBOX), "refresh-1");
  setTokenStore(tokens);
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot send and a cron cannot queue a read or a draft", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.drafts.create", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bad form and question ids are refused before any network call", async () => {
  const store = new MemoryStore();
  await assert.rejects(intake(context(WF, { ...SET, forms: [{ ...SET.forms[0], form_id: "../etc" }] }, store, NOW, () => {})), /bad form id/);
  await assert.rejects(draft(context(WF, { ...SET, forms: [{ ...SET.forms[0], fields: [{ question_id: "a/b", label: "x" }] }] }, store, NOW, () => {})), /bad question id/);
  assert.equal(hits.length, 0);
});

test("crons read and draft; a chase is queued, never sent, and only one draft is made per submission", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 3, updated: 0 });
  assert.deepEqual(await draft(ctx), { ready: 1, chasing: 1, needs_contact: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(draftsMade().length, 1, "one chase draft, for the one incomplete submission with an email");
  const raw = Buffer.from(draftsMade()[0].body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /To: sam@example\.com/);
  assert.match(raw, /Loan amount/);
  const queued = Object.values(await store.list<Approval>("approvals"));
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].acts.map((a) => a.op), ["gmail.users.drafts.send"]);
  // re-runs never draft or queue twice
  await intake(ctx); await draft(ctx);
  assert.equal(draftsMade().length, 1);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("a complete submission is marked ready with a field sheet and is never chased", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const ready = await bySender(store, "ari@example.com");
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.sheet, [["Full name", "Ari Patel"], ["Loan amount", "450000"], ["Notes", ""]]);
  assert.equal(ready.chased.length, 0);
});

test("a submission with no email is parked as needs-contact, not chased", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const parked = (await subs(store)).find((s) => s.status === "needs-contact")!;
  assert.deepEqual(parked.missing, ["Loan amount"]);
  assert.equal(draftsMade().length, 1, "no draft for the parked submission");
});

test("an approved chase sends the draft; the approval records the send", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].body, { id: "DRAFT1" });
});

test("a response edited since it was read is picked up again and turns ready", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  responses[1] = { ...responses[1], lastSubmittedTime: "2026-11-09T01:00:00Z", answers: { ...responses[1].answers, QB: answer("300000") } };
  assert.deepEqual(await intake(ctx), { added: 0, updated: 1 });
  assert.deepEqual(await draft(ctx), { ready: 1, chasing: 0, needs_contact: 1 });
  assert.equal((await bySender(store, "sam@example.com")).status, "ready");
});

test("follow-up comes due after the set days, once each, and stops after the last chase", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SET, store, NOW, () => {}));
  await draft(context(WF, SET, store, NOW, () => {}));
  const at = (d: number) => context(WF, SET, store, new Date(NOW.getTime() + d * DAY), () => {});
  assert.deepEqual(await followUp(at(2)), { queued: 0 }, "day 2: first follow-up not due");
  assert.deepEqual(await followUp(at(4)), { queued: 1 }, "day 4: second chase (3 days after the first)");
  assert.deepEqual(await followUp(at(5)), { queued: 0 });
  assert.deepEqual(await followUp(at(12)), { queued: 1 }, "day 12: third chase (7 days after the second)");
  assert.deepEqual(await followUp(at(40)), { queued: 0 }, "no chase after the last one");
  assert.equal(draftsMade().length, 3, "one draft per chase, never re-drafted");
  assert.equal(sends().length, 0);
  assert.equal((await bySender(store, "sam@example.com")).chased.length, 3);
});

test("a chased submission whose missing answer arrives is ready on the next draft run, and no chase is queued for it", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SET, store, NOW, () => {}));
  await draft(context(WF, SET, store, NOW, () => {}));
  responses[1] = { ...responses[1], lastSubmittedTime: "2026-11-10T00:00:00Z", answers: { ...responses[1].answers, QB: answer("120000") } };
  await intake(context(WF, SET, store, NOW, () => {}));
  await draft(context(WF, SET, store, NOW, () => {}));
  assert.equal((await bySender(store, "sam@example.com")).status, "ready");
  assert.deepEqual(await followUp(context(WF, SET, store, new Date(NOW.getTime() + 4 * DAY), () => {})), { queued: 0 });
  assert.equal(draftsMade().length, 1);
});

test("a chase whose response is unchanged is sent once, when approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts[0].check?.expect, [{ path: "lastSubmittedTime", equals: "2026-11-08T02:00:00Z" }]);
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "still one send");
});

test("a chase is rejected and nothing is sent when the client answered after it was queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  responses[1] = { ...responses[1], lastSubmittedTime: "2026-11-09T01:00:00Z", answers: { ...responses[1].answers, QB: answer("300000") } };
  const after = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(after.status, "rejected");
  assert.equal(after.decided_by, "check");
  assert.match(after.error ?? "", /changed after this was queued .*nothing was sent/);
  assert.equal(sends().length, 0, "no chase sent");
});

test("an edited response that is still incomplete is chased again once, as a fresh approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [first] = Object.values(await store.list<Approval>("approvals"));
  responses[1] = { ...responses[1], lastSubmittedTime: "2026-11-09T05:00:00Z", answers: { ...responses[1].answers, QC: answer("prefers mornings") } };
  await approve(WF, store, first.id, "owner", NOW);
  assert.equal(sends().length, 0);
  assert.deepEqual(await intake(ctx), { added: 0, updated: 1 });
  assert.deepEqual(await draft(ctx), { ready: 0, chasing: 1, needs_contact: 1 });
  await draft(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 2, "the rejected chase and one fresh chase, no more");
  const fresh = all.find((a) => a.status === "pending")!;
  assert.equal(draftsMade().length, 2, "a new draft for the new chase, never re-drafted");
  assert.equal((await approve(WF, store, fresh.id, "owner", NOW)).status, "done");
  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].body, { id: "DRAFT2" });
});
