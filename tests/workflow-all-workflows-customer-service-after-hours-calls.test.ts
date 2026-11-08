// After-hours calls workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, triage, morningHandover, CRONS } from "../industries/all/workflows/customer-service/after-hours-calls/index.ts";
import { insideHours, checkSettings, type Settings } from "../industries/all/workflows/customer-service/after-hours-calls/types.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/customer-service/after-hours-calls";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

// Aircall: 812 after hours (Sunday 09:00 Sydney), 813 inside hours (Friday 11:30), 814 an outbound call (ignored),
// 815 after hours with an unreadable number. JustCall: 9001 urgent, 9002 quote, 9003 outgoing (ignored), 9004 bad number.
function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/calls" && m === "GET") return json({ calls: [
        { id: 812, direction: "inbound", started_at: T("2026-11-07T22:00:00Z"), raw_digits: "+61 412 345 678" },
        { id: 813, direction: "inbound", started_at: T("2026-11-06T00:30:00Z"), raw_digits: "+61 412 345 679" },
        { id: 814, direction: "outbound", started_at: T("2026-11-07T23:00:00Z"), raw_digits: "+61 412 345 600" },
        { id: 815, direction: "inbound", started_at: T("2026-11-07T23:10:00Z"), raw_digits: "not a number" },
      ], meta: { count: 4 } });
      if (p === "/v1/contacts" && m === "POST") return json({ contact: { id: 719 } }, 201);
      if (p === "/v2.1/calls" && m === "GET") return json({ data: [
        { id: 9001, contact_number: "+61412345680", call_date: "2026-11-07", call_time: "22:00:00", call_info: { direction: "Incoming", notes: "burst pipe in the yard", voicemail_transcription: "" } },
        { id: 9002, contact_number: "+61412345682", call_date: "2026-11-07", call_time: "22:30:00", call_info: { direction: "Incoming", notes: "quote for gutters", voicemail_transcription: "" } },
        { id: 9003, contact_number: "+61412345683", call_date: "2026-11-07", call_time: "22:35:00", call_info: { direction: "Outgoing", notes: "" } },
        { id: 9004, contact_number: "12345", call_date: "2026-11-07", call_time: "22:45:00", call_info: { direction: "Incoming", notes: "" } },
      ] });
      if (p === "/v2.1/texts/new" && m === "POST") return json({ status: "success", data: { id: 5501 } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const texts = () => hits.filter((h) => h.path === "/v2.1/texts/new");
const S: Settings = {
  business_name: "Test Plumbing",
  hours: { timezone: "Australia/Sydney", days: [1, 2, 3, 4, 5], open: "07:30", close: "17:00" },
  call_platforms: ["aircall", "justcall"],
  aircall: { create_contacts: true },
  justcall: { number: "+61400000000" },
  on_call: { name: "Owner", phone: "+61400000001" },
  confirm_text: true,
  lookback_hours: 72,
};
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { AIRCALL_API_ID: "id-test", AIRCALL_API_TOKEN: "tok-test", JUSTCALL_API_KEY: "key-test", JUSTCALL_API_SECRET: "secret-test", KIT_ALLOW_WRITES: "1" });
});

test("every cron in workflow.json has an entry in index.ts, and no other", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
});

test("business hours: weekdays 07:30 to 17:00 Sydney; nights, weekends and the minute of close are outside", () => {
  assert.equal(insideHours(new Date("2026-11-06T00:30:00Z"), S.hours), true, "Friday 11:30 Sydney");
  assert.equal(insideHours(new Date("2026-11-07T22:00:00Z"), S.hours), false, "Sunday 09:00 Sydney");
  assert.equal(insideHours(new Date("2026-11-06T06:00:00Z"), S.hours), false, "Friday 17:00 Sydney is closing time");
  assert.equal(insideHours(new Date("2026-11-05T20:00:00Z"), S.hours), false, "Friday 07:00 Sydney is before opening");
});

test("settings: a bad opening time or number is refused before any cron runs", () => {
  assert.throws(() => checkSettings({ ...S, hours: { ...S.hours, open: "7:30" } }), /hours need/);
  assert.throws(() => checkSettings({ ...S, justcall: { number: "0400 000 000" } }), /E\.164/);
  assert.throws(() => checkSettings({ ...S, confirm_text: true, justcall: undefined }), /needs justcall/);
  checkSettings(S);
});

test("intake reads only after-hours incoming calls, once, and never texts anyone", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 5 }, "812, 815, 9001, 9002, 9004 are after hours; 9004 is kept for its bad number");
  const calls = await store.list<any>("calls");
  assert.equal(calls["aircall:812"]?.status, "new");
  assert.equal(Object.values(calls).filter((c: any) => c.status === "skipped").length, 1, "813 inside hours is skipped");
  assert.equal(Object.values(calls).length, 6, "the outbound calls are not stored");
  assert.deepEqual(await intake(ctx), { added: 0 }, "a second run adds nothing");
  assert.equal(texts().length, 0);
});

test("triage flags the urgent call, drafts one caller record, and queues texts for approval only", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await triage(ctx), { triaged: 5, urgent: 1, texts_queued: 3, contacts_drafted: 1 });
  assert.equal(texts().length, 0, "nothing texted by a cron");
  const contacts = hits.filter((h) => h.path === "/v1/contacts");
  assert.equal(contacts.length, 1, "one caller record, for the Aircall caller with a readable number");
  assert.equal(contacts[0].body.phone_numbers[0].value, "+61412345678");
  assert.equal(contacts[0].body.information, "external_custom_id:aircall:812");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 4, "three confirmation texts and one urgent alert");
  assert.ok(pending.every((a) => a.status === "pending"));
  await triage(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 4, "re-runs never queue twice");
  assert.equal(hits.filter((h) => h.path === "/v1/contacts").length, 1, "re-runs never create a second record");
  assert.equal(texts().length, 0);
});

test("an approved urgent alert texts the on-call number, and never includes the caller's words", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await triage(ctx);
  const ap = await approve(WF, store, approvalId(WF.id, "alert:justcall:9001"), "owner", NOW);
  assert.equal(ap.status, "done");
  const sent = texts().at(-1)!.body;
  assert.equal(sent.justcall_number, "+61400000000");
  assert.equal(sent.contact_number, "+61400000001");
  assert.equal(sent.restrict_once, "Yes");
  assert.match(sent.body, /Urgent after-hours call from \+61412345680/);
  assert.doesNotMatch(sent.body, /burst|pipe/, "the caller's notes are data and never reach the text");
  await assert.rejects(approve(WF, store, approvalId(WF.id, "alert:justcall:9001"), "owner"), /already done/);
});

test("a live operation cannot run as a draft, and a read cannot be queued", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "justcall", op: "docs.post_v2_1_texts_new", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "justcall", op: "docs.get_v2_1_calls", summary: "x" }), /not a live operation/);
});

test("a caller with an unreadable number is never texted or recorded", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await triage(ctx);
  const approvals = Object.values(await store.list<Approval>("approvals")).flatMap((a) => a.acts.map((x) => x.input?.body?.contact_number));
  assert.ok(!approvals.includes("12345"), "JustCall's bad number is not texted");
  assert.ok(!approvals.includes(undefined));
});

test("morning handover lists the out-of-hours calls once, with urgency and no caller notes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await triage(ctx);
  assert.deepEqual(await morningHandover(ctx), { calls: 5, urgent: 1 });
  const [note] = Object.values(await store.list<any>("handovers"));
  assert.match(note.text, /URGENT/);
  assert.match(note.text, /\+61412345680/);
  assert.doesNotMatch(note.text, /burst/, "notes are not copied into the handover");
  assert.deepEqual(await morningHandover(ctx), { calls: 0, urgent: 0 }, "a second run hands over nothing new");
  assert.equal(texts().length, 0, "the handover never texts anyone");
});
