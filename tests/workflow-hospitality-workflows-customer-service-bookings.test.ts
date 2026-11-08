// Bookings workflow tests. Every request goes to a fake network: no test reaches a real Google account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey, clearTokenCache } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { hold, changes } from "../industries/hospitality/workflows/customer-service/bookings/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/customer-service/bookings/workflow.json", "utf8")) as WorkflowRecord;
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", CAL = "bookings@example.com.au", MAILBOX = "owner@example.com.au";
const HEAD = ["Guest", "Headcount", "Start", "End", "Booked value", "Original value", "Logged value", "Status", "Event ID", "Note"];
const S: any = { business_name: "Test Venue", timezone: "Australia/Sydney", google_workspace: { calendar_id: CAL, spreadsheet_id: SHEET } };
const NOW = new Date("2026-11-09T10:00:00Z");

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let grid: unknown[][] = [];
let busyList: { start: string; end: string }[] = [];
let calendarUnreadable = false, insertFails = false;
let appended: unknown[][] = [];

function fake() {
  hits = []; grid = [HEAD]; busyList = []; calendarUnreadable = false; insertFails = false; appended = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = decodeURIComponent(u.pathname);
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "tok", expires_in: 3600 });
      if (p.startsWith("/v4/spreadsheets/")) {
        if (p.endsWith(":append")) { appended.push(...body.values); return json({ updates: {} }); }
        const row = p.match(/\/values\/Bookings!A(\d+):J\d+$/);
        if (m === "PUT" && row) { grid[Number(row[1]) - 1] = [...body.values[0]]; return json({}); }
        if (m === "GET") return json({ range: "Bookings", values: grid });
      }
      if (p === "/calendar/v3/freeBusy" && m === "POST") {
        const id = body.items[0].id;
        return json({ calendars: { [id]: calendarUnreadable ? { busy: [], errors: [{ reason: "notFound" }] } : { busy: busyList } } });
      }
      if (p === `/calendar/v3/calendars/${CAL}/events` && m === "POST") {
        if (insertFails) return json({}, 500);
        return json({ id: `hold${hits.filter((h) => h.method === "POST" && h.path.endsWith("/events")).length}abc` });
      }
      if (p.startsWith(`/calendar/v3/calendars/${CAL}/events/`) && m === "PATCH") return json({ id: p.split("/").pop() });
      if (p.startsWith(`/calendar/v3/calendars/${CAL}/events/`) && m === "DELETE") return new Response(null, { status: 204 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const line = (o: Partial<Record<"guest" | "headcount" | "start" | "end" | "booked" | "original" | "logged" | "status" | "eventId" | "note", string | number>>): unknown[] =>
  [o.guest ?? "", o.headcount ?? "", o.start ?? "", o.end ?? "", o.booked ?? "", o.original ?? "", o.logged ?? "", o.status ?? "", o.eventId ?? "", o.note ?? ""];
const ENQUIRY = { guest: "Ari Lee", headcount: 40, start: "2026-12-05T18:00:00+11:00", end: "2026-12-05T22:00:00+11:00", booked: 4800, status: "Enquiry" };

beforeEach(() => {
  fake(); clearTokenCache();
  const tokens = new MemoryTokenStore(); setTokenStore(tokens);
  tokens.values.set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("hold: a free enquiry gets a calendar hold with no guests invited, and the row comes back Held", async () => {
  grid.push(line(ENQUIRY));
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 1, clash: 0, check: 0 });
  const insert = hits.find((h) => h.method === "POST" && h.path.endsWith("/events"))!;
  assert.match(insert.query, /sendUpdates=none/);
  assert.equal(insert.body.attendees, undefined);
  assert.equal(insert.body.summary, "HOLD Ari Lee (40)");
  assert.equal(hits.filter((h) => h.method === "PATCH" || h.method === "DELETE").length, 0, "a hold cron never moves or removes");
  const r = grid[1] as unknown[];
  assert.equal(r[7], "Held");
  assert.equal(r[5], 4800, "original value kept");
  assert.equal(r[6], 4800, "logged value set at hold");
  assert.equal(r[8], "hold1abc");
});

test("hold: a second run never holds the same enquiry twice", async () => {
  grid.push(line(ENQUIRY));
  await hold(context(WF, S, new MemoryStore(), NOW, () => {}));
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 0, clash: 0, check: 0 });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/events")).length, 1);
});

test("hold: a busy calendar marks the row Clash and holds nothing", async () => {
  grid.push(line(ENQUIRY));
  busyList = [{ start: "2026-12-05T17:00:00+11:00", end: "2026-12-05T19:00:00+11:00" }];
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 0, clash: 1, check: 0 });
  assert.equal((grid[1] as unknown[])[7], "Clash");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/events")).length, 0);
});

test("hold: a row that cannot be read is marked Check, not held", async () => {
  grid.push(line({ ...ENQUIRY, headcount: "", start: "2026-12-05 18:00", end: "2026-12-05 22:00" }));
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 0, clash: 0, check: 1 });
  const r = grid[1] as unknown[];
  assert.equal(r[7], "Check");
  assert.match(String(r[9]), /headcount/);
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/events")).length, 0);
});

test("hold: a calendar that cannot be read is marked Check", async () => {
  grid.push(line(ENQUIRY));
  calendarUnreadable = true;
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 0, clash: 0, check: 1 });
  assert.equal((grid[1] as unknown[])[7], "Check");
});

test("hold: a failed calendar insert leaves the row Check with its original value kept", async () => {
  grid.push(line(ENQUIRY));
  insertFails = true;
  assert.deepEqual(await hold(context(WF, S, new MemoryStore(), NOW, () => {})), { held: 0, clash: 0, check: 1 });
  const r = grid[1] as unknown[];
  assert.equal(r[7], "Check");
  assert.equal(r[5], 4800);
});

test("hold: text from the sheet is escaped before it is written back", async () => {
  grid.push(line({ ...ENQUIRY, guest: '=HYPERLINK("https://example.com")' }));
  await hold(context(WF, S, new MemoryStore(), NOW, () => {}));
  assert.equal(String((grid[1] as unknown[])[0]).startsWith("'="), true);
});

test("changes: a booked-value change is logged once and the row is marked logged", async () => {
  grid.push(line({ ...ENQUIRY, status: "Held", original: 4800, logged: 4800, booked: 4500, eventId: "hold1abc" }));
  assert.deepEqual(await changes(context(WF, S, new MemoryStore(), NOW, () => {})), { changes: 1, queued: 0 });
  assert.equal(appended.length, 1);
  assert.equal(appended[0][4], 4500, "now booked");
  assert.equal(appended[0][5], -300, "difference");
  assert.equal((grid[1] as unknown[])[6], 4500);
  assert.deepEqual(await changes(context(WF, S, new MemoryStore(), NOW, () => {})), { changes: 0, queued: 0 });
  assert.equal(appended.length, 1, "a second run logs nothing new");
});

test("changes: a cancelled booking queues a calendar removal, which runs only on approval", async () => {
  grid.push(line({ ...ENQUIRY, status: "Cancelled", original: 4800, logged: 4800, booked: 4800, eventId: "hold1abc" }));
  const store = new MemoryStore();
  assert.deepEqual(await changes(context(WF, S, store, NOW, () => {})), { changes: 0, queued: 1 });
  assert.equal(hits.filter((h) => h.method === "DELETE").length, 0, "nothing deleted by the cron");
  await changes(context(WF, S, store, NOW, () => {}));
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "re-runs never queue twice");
  assert.equal(approvals[0].acts[0].op, "calendar.events.delete");
  const ap = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(hits.filter((h) => h.method === "DELETE").length, 1);
});

test("changes: a moved booking queues a calendar move, and a row with no hold is marked Check", async () => {
  grid.push(line({ ...ENQUIRY, status: "Moved", original: 4800, logged: 4800, booked: 4800, eventId: "hold1abc",
    start: "2026-12-06T18:00:00+11:00", end: "2026-12-06T22:00:00+11:00" }));
  grid.push(line({ ...ENQUIRY, guest: "Sam", status: "Moved", original: 100, logged: 100, booked: 100 }));
  const store = new MemoryStore();
  assert.deepEqual(await changes(context(WF, S, store, NOW, () => {})), { changes: 0, queued: 1 });
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "calendar.events.patch");
  assert.equal(ap.acts[0].input?.body && (ap.acts[0].input.body as any).start.dateTime, "2026-12-06T18:00:00+11:00");
  assert.equal((grid[2] as unknown[])[7], "Check");
});

test("a live calendar operation can never run as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "calendar.events.delete", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "sheets.spreadsheets.values.append", summary: "x" }), /not a live operation/);
});

test("a tab with other columns is refused before any change is written", async () => {
  grid = [["Name", "Party size"]];
  await assert.rejects(hold(context(WF, S, new MemoryStore(), NOW, () => {})), /must start with these columns/);
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0);
});

test("bad settings are refused before any network call", async () => {
  const bad = { ...S, google_workspace: { calendar_id: "not an address", spreadsheet_id: SHEET } };
  await assert.rejects(hold(context(WF, bad, new MemoryStore(), NOW, () => {})), /calendar_id/);
  assert.equal(hits.length, 0);
});
