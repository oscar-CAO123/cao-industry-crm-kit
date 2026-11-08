// Events workflow tests. Every request goes to a fake network: no test reaches a real Google account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey, clearTokenCache } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, safeKey, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, check } from "../industries/hospitality/workflows/fulfilment/events/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/fulfilment/events/workflow.json", "utf8")) as WorkflowRecord;
const CAL = "events@example.com.au", MAILBOX = "owner@example.com.au";
const S: any = { business_name: "Test Venue", timezone: "Australia/Sydney", google_workspace: { calendar_id: CAL },
  enquiries: { query: "label:enquiries", max_results: 25 }, signoff: "The events team" };
const NOW = new Date("2026-11-09T10:00:00Z");
const BOOKING = { start: "2026-12-05T18:00:00+11:00", end: "2026-12-05T22:00:00+11:00", guests: 40, event: "Christmas party" };
const M1 = safeKey("gmail:m1"), M2 = safeKey("gmail:m2");
const INSERT_PATH = `/calendar/v3/calendars/${CAL}/events`;

const MAILS: Record<string, any> = {
  m1: { id: "m1", threadId: "t1", internalDate: String(Date.parse("2026-11-08T23:00:00Z")), payload: { headers: [
    { name: "From", value: "Ari Lee <ari@example.com>" }, { name: "Subject", value: "Party of 40 in December" },
    { name: "Message-ID", value: "<m1@mail.example.com>" }] } },
  m2: { id: "m2", threadId: "t2", payload: { headers: [{ name: "From", value: "Sam" }, { name: "Subject", value: "Hi" }] } },
};

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let busyList: { start: string; end: string }[] = [];
let calendarUnreadable = false, insertFails = false;

function fake() {
  hits = []; busyList = []; calendarUnreadable = false; insertFails = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = decodeURIComponent(u.pathname);
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const n = hits.filter((h) => h.method === m && h.path === p).length;
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "tok", expires_in: 3600 });
      if (p === "/gmail/v1/users/me/messages" && m === "GET") return json({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] });
      if (m === "GET" && /^\/gmail\/v1\/users\/me\/messages\/m[12]$/.test(p)) return json(MAILS[p.split("/").pop()!]);
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "sent1", threadId: "t1" });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: `d${n}`, message: { id: `dm${n}`, threadId: "t1" } });
      if (p === "/calendar/v3/freeBusy" && m === "POST") {
        const id = body.items[0].id;
        return json({ calendars: { [id]: calendarUnreadable ? { busy: [], errors: [{ reason: "notFound" }] } : { busy: busyList } } });
      }
      if (p === INSERT_PATH && m === "POST") return insertFails ? json({}, 500) : json({ id: `hold${n}abc` });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const posts = (path: string) => hits.filter((h) => h.method === "POST" && h.path === path);
const sends = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts/send");

beforeEach(() => {
  fake(); clearTokenCache();
  const tokens = new MemoryTokenStore(); setTokenStore(tokens);
  tokens.values.set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("intake: reads enquiry headers only, adds each email once, and marks a sender with no address skipped", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 2 });
  const e1 = await store.get<any>("enquiries", M1);
  assert.equal(e1.from, "ari@example.com");
  assert.equal(e1.status, "new");
  assert.equal(e1.rfc_message_id, "<m1@mail.example.com>");
  assert.equal((await store.get<any>("enquiries", M2)).status, "skipped");
  assert.deepEqual(await intake(context(WF, S, store, NOW, () => {})), { added: 0 });
  assert.equal(hits.filter((h) => h.method === "POST" && !h.path.endsWith("/token")).length, 0, "intake sends and drafts nothing (the only POST is the sign-in)");
});

test("check: an enquiry with no booking details is marked needs-details, with no hold and no draft", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 0, details: 1, check: 0 });
  assert.equal((await store.get<any>("enquiries", M1)).status, "needs-details");
  assert.equal(posts(INSERT_PATH).length, 0);
  assert.equal(posts("/gmail/v1/users/me/drafts").length, 0);
});

test("check: a free date gets a hold with no guests, a reply draft in the thread, and one queued send", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, BOOKING);
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 1, clash: 0, details: 0, check: 0 });

  const insert = posts(INSERT_PATH)[0];
  assert.match(insert.query, /sendUpdates=none/);
  assert.equal(insert.body.attendees, undefined, "no guests invited");
  assert.equal(insert.body.transparency, "opaque");

  const draft = posts("/gmail/v1/users/me/drafts")[0];
  assert.equal(draft.body.message.threadId, "t1");
  const raw = Buffer.from(draft.body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: ari@example\.com/m);
  assert.match(raw, /In-Reply-To: <m1@mail\.example\.com>/);
  assert.match(raw, /Saturday, 5 December 2026|Saturday 5 December 2026/);
  assert.equal(sends().length, 0, "the cron never sends");

  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "gmail.users.drafts.send");
  assert.equal((ap.acts[0].input?.body as any).id, "d1");
  const e = await store.get<any>("enquiries", M1);
  assert.equal(e.status, "replied");
  assert.equal(e.hold_event_id, "hold1abc");

  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 0, details: 0, check: 0 });
  assert.equal(posts(INSERT_PATH).length, 1, "a second run never holds the same enquiry twice");
  assert.equal(posts("/gmail/v1/users/me/drafts").length, 1, "nor drafts it twice");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
});

test("approval: the reply is sent only when a person approves it, and only once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, BOOKING);
  await check(context(WF, S, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(sends().length, 0);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal((sends()[0].body as any).id, "d1");
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("check: a busy calendar marks the enquiry Clash, with no hold and no draft", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, BOOKING);
  busyList = [{ start: "2026-12-05T17:00:00+11:00", end: "2026-12-05T19:00:00+11:00" }];
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 1, details: 0, check: 0 });
  assert.equal((await store.get<any>("enquiries", M1)).status, "clash");
  assert.equal(posts(INSERT_PATH).length, 0);
  assert.equal(posts("/gmail/v1/users/me/drafts").length, 0);
});

test("check: a hold that does not confirm is marked check, and no reply is drafted", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, BOOKING);
  insertFails = true;
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 0, details: 0, check: 1 });
  const e = await store.get<any>("enquiries", M1);
  assert.equal(e.status, "check");
  assert.equal(e.hold_event_id, undefined);
  assert.equal(posts("/gmail/v1/users/me/drafts").length, 0);
});

test("check: an unreadable calendar is marked check and holds nothing", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, BOOKING);
  calendarUnreadable = true;
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 0, details: 0, check: 1 });
  assert.equal(posts(INSERT_PATH).length, 0);
});

test("check: booking details that do not add up are refused before any call", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await store.put("bookings", M1, { ...BOOKING, end: "2026-12-05T17:00:00+11:00" });
  hits = [];
  assert.deepEqual(await check(context(WF, S, store, NOW, () => {})), { held: 0, clash: 0, details: 1, check: 0 });
  assert.equal(hits.length, 0);
  assert.equal((await store.get<any>("enquiries", M1)).note, "end is not after start");
});

test("a live operation can never run as a draft, and a draft operation can never be queued as live", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "calendar.events.insert", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bad settings are refused before any network call", async () => {
  const bad = { ...S, google_workspace: { calendar_id: "not an address" } };
  await assert.rejects(intake(context(WF, bad, new MemoryStore(), NOW, () => {})), /calendar_id/);
  assert.equal(hits.length, 0);
});
