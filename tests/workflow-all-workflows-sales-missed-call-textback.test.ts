// Missed-call text-back workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, textback, logCalls, CRONS } from "../industries/all/workflows/sales/missed-call-textback/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/sales/missed-call-textback";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CON = "con0001abcd";
const NOW = new Date("2026-11-08T00:00:00Z");
const MIN = 60_000;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let calls: any[] = [];

function fake() {
  hits = [];
  calls = [
    { id: 1001, call_date: "2026-11-07", call_time: "09:15:00", contact_number: "+61 412 345 678", justcall_number: "+61412345678",
      call_info: { direction: "Incoming", type: "Missed" } },
    { id: 1002, call_date: "2026-11-07", call_time: "10:00:00", contact_number: "not a number", justcall_number: "+61412345678",
      call_info: { direction: "Incoming", type: "Missed" } },
    { id: "../evil", call_date: "2026-11-07", call_time: "10:30:00", contact_number: "+61400111222", justcall_number: "+61412345678",
      call_info: { direction: "Incoming", type: "Missed" } },
    { id: 1003, call_date: "2026-11-01", call_time: "08:00:00", contact_number: "+61400333444", justcall_number: "+61412345678",
      call_info: { direction: "Incoming", type: "Missed" } },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v2.1/calls" && m === "GET") return json({ data: calls });
      if (p === "/v2.1/texts/new" && m === "POST") return json({ status: "success", data: { id: 9001 } });
      if (p === "/contacts/upsert" && m === "POST") return json({ new: true, contact: { id: CON } });
      if (p === `/contacts/${CON}/notes` && m === "POST") return json({ note: { id: "note1" } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const texts = () => hits.filter((h) => h.method === "POST" && h.path === "/v2.1/texts/new");
const notes = () => hits.filter((h) => h.method === "POST" && /\/notes$/.test(h.path));
const conversationWrites = () => hits.filter((h) => h.path.startsWith("/conversations"));
const S: any = {
  business_name: "Test Plumbing", justcall: { number: "+61412345678" }, gohighlevel: { location_id: "loc0001abcd" },
  textback: { message: "Hi, sorry we missed your call at {business}. Reply here and we will get back to you.", lookback_hours: 24 },
};
const at = (min: number) => new Date(NOW.getTime() + min * MIN);

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { JUSTCALL_API_KEY: "key-test", JUSTCALL_API_SECRET: "secret-test", GHL_ACCESS_TOKEN: "ghl-test", KIT_ALLOW_WRITES: "1" });
});

test("crons: the registry names the three entries", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["intake", "log", "textback"]);
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), ["intake", "log", "textback"]);
});

test("runtime: a cron cannot send a text as a draft, and cannot queue a note", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "justcall", op: "docs.post_v2_1_texts_new", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "contacts.create-note", summary: "x" }), /not a live operation/);
});

test("intake: records each missed call once, keeps only valid caller numbers, and drops bad ids", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 1 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "intake reads only");
  const rows = await store.list<any>("calls");
  assert.deepEqual(Object.keys(rows).sort(), ["justcall:1001", "justcall:1002"]);
  assert.equal(rows["justcall:1001"].caller, "+61412345678");
  assert.match(rows["justcall:1002"].closed, /no valid caller number/);
  assert.deepEqual(await intake(context(WF, S, store, at(10), () => {})), { added: 0 });
  assert.equal(Object.keys(await store.list("calls")).length, 2, "a re-run records nothing new");
});

test("textback: one text is queued for approval and never sent by the cron", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await textback(context(WF, S, store, at(10), () => {})), { queued: 1 });
  assert.equal(texts().length, 0, "nothing sent by a cron");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["docs.post_v2_1_texts_new"]);
  assert.equal(aps[0].acts[0].input?.body.contact_number, "+61412345678");
  assert.equal(aps[0].acts[0].input?.body.justcall_number, "+61412345678");
  assert.equal(aps[0].acts[0].input?.body.body, "Hi, sorry we missed your call at Test Plumbing. Reply here and we will get back to you.");
});

test("textback: re-runs never queue the same caller twice", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await textback(context(WF, S, store, at(10), () => {}));
  assert.deepEqual(await textback(context(WF, S, store, at(20), () => {})), { queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("textback: a missed call older than the lookback when first picked up is closed, not texted", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await textback(context(WF, S, store, at(3 * 24 * 60), () => {})), { queued: 0 });
  const rows = await store.list<any>("calls");
  assert.match(rows["justcall:1001"].closed, /older than the lookback/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("textback: an approved text runs once, through the approval, and a second approval is refused", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await textback(context(WF, S, store, at(10), () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", at(11));
  assert.equal(done.status, "done");
  assert.equal(texts().length, 1);
  assert.equal(texts()[0].body.contact_number, "+61412345678");
  await assert.rejects(approve(WF, store, ap.id, "owner", at(12)), /already done/);
});

test("log: one contact lookup and one internal note per missed call, drafts only, never twice", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await logCalls(context(WF, S, store, at(15), () => {})), { logged: 1, failed: 0 });
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].path, `/contacts/${CON}/notes`);
  assert.match(notes()[0].body.body, /Missed call from \+61412345678/);
  assert.equal(conversationWrites().length, 0, "no text is sent through GoHighLevel");
  assert.deepEqual(await logCalls(context(WF, S, store, at(30), () => {})), { logged: 0, failed: 0 });
  assert.equal(notes().length, 1, "a re-run never writes the same note again");
});

test("log: with no GoHighLevel setting nothing is written", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  const noCrm = { ...S, gohighlevel: undefined };
  assert.deepEqual(await logCalls(context(WF, noCrm, store, at(15), () => {})), { logged: 0 });
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("settings: a JustCall number that is not E.164 is refused before any call", async () => {
  await assert.rejects(intake(context(WF, { ...S, justcall: { number: "0412 345 678" } }, new MemoryStore(), NOW, () => {})), /justcall\.number must be E\.164/);
  assert.equal(hits.length, 0);
});
