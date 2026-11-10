// Customer research workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { responses, invite, summarise, inviteHtml } from "../industries/all/workflows/marketing/customer-research/index.ts";
import { googleWorkspace, mimeRaw } from "../industries/all/workflows/marketing/customer-research/adapters/google-workspace.ts";
import { calendly } from "../industries/all/workflows/marketing/customer-research/adapters/calendly.ts";
import type { Settings } from "../industries/all/workflows/marketing/customer-research/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/marketing/customer-research/workflow.json", "utf8")) as WorkflowRecord;
const FORM = "FORM_abcdefghijKLMNOP_12345";
const SHEET = "SHEET_abcdefghijklmnopqrstu1234";
const OWNER = "owner@example.com";
const MAILBOX = "owner@example.com";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let draftSeq = 0;

function fake() {
  hits = []; draftSeq = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      // Google Forms
      if (/^\/v1\/forms\/[^/]+$/.test(p) && m === "GET") return json({ formId: FORM, items: [
        { title: "How happy are you with us?", questionItem: { question: { questionId: "q1" } } },
        { title: "What could we do better?", questionItem: { question: { questionId: "q2" } } }] });
      if (/\/responses$/.test(p) && m === "GET") return json({ responses: [
        { responseId: "RESP_A1", lastSubmittedTime: "2026-11-07T01:00:00Z", respondentEmail: "sam@example.com",
          answers: { q1: { questionId: "q1", textAnswers: { answers: [{ value: "Very happy" }] } }, q2: { questionId: "q2", textAnswers: { answers: [{ value: "=HYPERLINK(\"http://x\")" }] } } } }] });
      // Gmail
      if (/\/drafts\/send$/.test(p) && m === "POST") return json({ id: body?.id, labelIds: ["SENT"] });
      if (/\/drafts$/.test(p) && m === "POST") { draftSeq++; return json({ id: `r-draft-${draftSeq}` }); }
      // Sheets
      if (decodeURIComponent(p).endsWith(":append") && m === "POST") return json({ updates: { updatedRows: 1 } });
      // Calendly
      if (p === "/routing_form_submissions" && m === "GET") return json({ collection: [
        { uri: "https://api.calendly.com/routing_form_submissions/SUB1", created_at: "2026-11-07T02:00:00Z",
          questions_and_answers: [{ question: "Rate us", answer: "8" }, { question: "Email", answer: "ari@example.com" }] }],
        pagination: { next_page_token: null } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const sendHits = () => hits.filter((h) => /\/drafts\/send$/.test(h.path) || /\/messages\/send$/.test(h.path));
const draftHits = () => hits.filter((h) => h.method === "POST" && /\/drafts$/.test(h.path));
const appendHits = () => hits.filter((h) => h.method === "POST" && decodeURIComponent(h.path).endsWith(":append"));
/** Decodes a Gmail draft's raw message into its header block and its HTML body. */
function decodeMail(raw: string) {
  const s = Buffer.from(raw, "base64url").toString("utf8");
  const i = s.indexOf("\r\n\r\n");
  const body = Buffer.from(s.slice(i + 4).replace(/\r\n/g, ""), "base64").toString("utf8");
  return { head: s.slice(0, i), body };
}

const GS: Settings = {
  business_name: "Test Plumbing", owner_email: OWNER,
  survey: { source: "google-forms", google_form_id: FORM, survey_url: "https://docs.google.com/forms/d/e/abc/viewform" },
  research_log: { spreadsheet_id: SHEET, sheet: "Responses" },
  invite: { audience: [{ name: "Sam Lee", email: "sam@example.com" }, { name: "Ari", email: "ari@example.com" }] },
};
const CAL: Settings = { ...GS, survey: { source: "calendly", calendly_form_uri: "https://api.calendly.com/routing_forms/ABCD1234", survey_url: "https://calendly.com/d/abcd" }, research_log: undefined };

beforeEach(async () => {
  fake();
  const ts = new MemoryTokenStore(); await ts.set(refreshKey(MAILBOX), "r1"); setTokenStore(ts);
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", CALENDLY_API_TOKEN: "c", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, GS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", input: { params: { userId: "me" }, body: { id: "r-draft-1" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "forms.forms.get", summary: "x" }), /not a live operation/);
});

test("responses: each new answer is stored once and logged once; crons never send", async () => {
  const store = new MemoryStore(), ctx = context(WF, GS, store, NOW, () => {});
  assert.deepEqual(await responses(ctx), { added: 1 });
  assert.equal(appendHits().length, 1);
  const row = appendHits()[0].body.values[0];
  assert.equal(row[0], "2026-11-07T01:00:00Z");
  assert.equal(row[2], "sam@example.com");
  assert.equal(row[3], "How happy are you with us?: Very happy");
  assert.equal(row[4], "What could we do better?: =HYPERLINK(\"http://x\")");
  assert.equal(sendHits().length, 0, "nothing sent by a cron");
  assert.deepEqual(await responses(ctx), { added: 0 });
  assert.equal(appendHits().length, 1, "a re-run never logs the same response twice");
});

test("invite: one Gmail draft per customer, one send approval each, nothing sent; re-runs add nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, GS, store, NOW, () => {});
  assert.deepEqual(await invite(ctx), { drafted: 2, waiting: 2 });
  assert.equal(draftHits().length, 2);
  assert.equal(sendHits().length, 0, "a cron never sends");
  const mail = decodeMail(draftHits()[0].body.message.raw);
  assert.match(mail.head, /To: sam@example\.com/);
  assert.match(mail.body, /https:\/\/docs\.google\.com\/forms\/d\/e\/abc\/viewform/);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 2);
  assert.ok(aps.every((a) => a.status === "pending" && a.acts[0].op === "gmail.users.drafts.send"));
  assert.deepEqual(await invite(ctx), { drafted: 0, waiting: 2 });
  assert.equal(draftHits().length, 2, "re-runs reuse the draft");
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "re-runs never queue twice");
});

test("invite: an approved send runs the draft, and a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, GS, store, NOW, () => {});
  await invite(ctx);
  const aps = Object.values(await store.list<Approval>("approvals"));
  const pick = aps.find((a) => a.acts[0].summary.includes("sam@example.com"))!;
  const ap = await approve(WF, store, pick.id, "owner", NOW);
  assert.equal(ap.status, "done");
  const send = sendHits()[0];
  assert.match(send.path, /\/gmail\/v1\/users\/me\/drafts\/send$/);
  assert.equal(send.body.id, "r-draft-1");
  await assert.rejects(approve(WF, store, pick.id, "owner", NOW), /already done/);
  assert.equal(await invite(context(WF, GS, store, NOW, () => {})).then((r) => r.drafted), 0, "a sent invite is never drafted again");
});

test("summarise: one draft to the owner per day, with counts; a second run that day adds nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, GS, store, NOW, () => {});
  await responses(ctx);
  assert.deepEqual(await summarise(ctx), { drafted: 1, responses: 1 });
  const mail = decodeMail(draftHits().at(-1)!.body.message.raw);
  assert.match(mail.head, /To: owner@example\.com/);
  assert.match(mail.body, /Very happy: 1/);
  assert.equal(sendHits().length, 0);
  assert.deepEqual(await summarise(ctx), { drafted: 0 });
  assert.equal(draftHits().length, 1, "one summary draft and no invites in this test");
});

test("calendly source: submissions are read and stored with the email found in the answers, nothing written", async () => {
  const store = new MemoryStore(), ctx = context(WF, CAL, store, NOW, () => {});
  assert.deepEqual(await responses(ctx), { added: 1 });
  const stored = Object.values(await store.list<any>("responses"))[0];
  assert.equal(stored.email, "ari@example.com");
  assert.equal(stored.answers[0].answer, "8");
  assert.equal(hits.filter((h) => h.method !== "GET" && !/\/token$/.test(h.path)).length, 0, "reads only");
});

test("invite HTML escapes the business name and links the survey", () => {
  const html = inviteHtml({ ...GS, business_name: "<Ben & Sons>" }, "Sam Lee");
  assert.match(html, /&lt;Ben &amp; Sons&gt;/);
  assert.doesNotMatch(html, /<Ben/);
  assert.match(html, /href="https:\/\/docs\.google\.com\/forms\/d\/e\/abc\/viewform"/);
});

test("header line breaks are refused before any draft is made", () => {
  assert.throws(() => mimeRaw("sam@example.com", "Hi\r\nBcc: x@example.com", "<p>x</p>"), /line break/);
  assert.throws(() => mimeRaw("sam@example.com\r\nBcc: x@example.com", "Hi", "<p>x</p>"), /line break/);
});

test("bad settings are refused before any network call", async () => {
  const bad: Settings = { ...GS, survey: { ...GS.survey, survey_url: "http://insecure.example.com/x" } };
  await assert.rejects(responses(context(WF, bad, new MemoryStore(), NOW, () => {})), /https link/);
  const badAudience: Settings = { ...GS, invite: { audience: [{ email: "not an email" }] } };
  await assert.rejects(invite(context(WF, badAudience, new MemoryStore(), NOW, () => {})), /audience email/);
  assert.equal(hits.length, 0);
});

test("with writes blocked on the deploy, a draft is refused and nothing reaches the network", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, GS, new MemoryStore(), NOW, () => {});
  await assert.rejects(googleWorkspace.draftMail(ctx, "sam@example.com", "Hi", "<p>x</p>"), WriteBlocked);
  assert.equal(draftHits().length, 0);
});

test("the Calendly adapter refuses a form URI that is not a routing form", async () => {
  await assert.rejects(calendly.responses(context(WF, CAL, new MemoryStore(), NOW, () => {}), "https://evil.example.com/x"), /routing form URI/);
  assert.equal(hits.filter((h) => h.path === "/routing_form_submissions").length, 0);
});
