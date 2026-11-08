// Event ticketing workflow tests. Every request goes to a fake network: no test reaches a real Eventbrite account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { setup, registrations, runDay, wrapUp, CRONS } from "../industries/all/workflows/fulfilment/event-ticketing/index.ts";
import fs from "node:fs";

const FOLDER = "industries/all/workflows/fulfilment/event-ticketing";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];

// Fixtures. Event 111 is a draft with a venue and a ticket type, starting in 12 days (ready, outside the run-sheet window).
// Event 222 is live, starts in two days (inside the window), and has attendees and a check-in team.
// Event 333 ended on 1 November and has three attendees (one cancelled, one refunded and checked in).
const EV: Record<string, any> = {
  "111": { id: "111", name: { text: "Spring Gala" }, status: "draft", online_event: false, venue_id: "500",
    start: { utc: "2026-11-20T08:00:00Z", timezone: "Australia/Sydney", local: "2026-11-20T19:00:00" }, end: { utc: "2026-11-20T12:00:00Z" } },
  "222": { id: "222", name: { text: "Trade Night" }, status: "live", online_event: false, venue_id: "501",
    start: { utc: "2026-11-10T08:00:00Z", timezone: "Australia/Sydney", local: "2026-11-10T19:00:00" }, end: { utc: "2026-11-10T12:00:00Z" } },
  "333": { id: "333", name: { text: "Launch Lunch" }, status: "ended", online_event: false, venue_id: "502",
    start: { utc: "2026-11-01T01:00:00Z", timezone: "Australia/Sydney" }, end: { utc: "2026-11-01T04:00:00Z" } },
};
const TC: Record<string, any[]> = { "111": [{ id: "9100", name: "General" }], "222": [{ id: "9200", name: "General" }], "333": [{ id: "9300", name: "General" }] };
const AT: Record<string, any[]> = {
  "222": [
    { id: "9001", changed: "2026-11-07T10:00:00Z", order_id: "8001", ticket_class_name: "General", status: "Attending", checked_in: false, cancelled: false, refunded: false, profile: { name: "Ari Test", email: "ari@example.com" } },
    { id: "9002", changed: "2026-11-07T11:00:00Z", order_id: "8002", ticket_class_name: "General", status: "Checked In", checked_in: true, cancelled: false, refunded: false, profile: { name: "Sam Test", email: "sam@example.com" } },
  ],
  "333": [
    { id: "9301", changed: "2026-10-30T10:00:00Z", order_id: "8301", ticket_class_name: "General", status: "Attending", checked_in: true, cancelled: false, refunded: false, profile: { name: "Ned Test", email: "ned@example.com" } },
    { id: "9302", changed: "2026-10-30T11:00:00Z", order_id: "8302", ticket_class_name: "General", status: "Not Attending", checked_in: false, cancelled: true, refunded: false, profile: { name: "Ivy Test", email: "ivy@example.com" } },
    { id: "9303", changed: "2026-10-30T12:00:00Z", order_id: "8303", ticket_class_name: "General", status: "Attending", checked_in: true, cancelled: false, refunded: true, profile: { name: "Max Test", email: "max@example.com" } },
  ],
};
const TEAMS: Record<string, any[]> = { "222": [{ id: "71", name: "Check-in A", attendee_count: 2 }] };
let more: Record<string, boolean> = {};

function fake() {
  hits = []; more = {};
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      const ev = p.match(/^\/v3\/events\/(\d+)\/$/);
      if (ev && m === "GET") return EV[ev[1]] ? json(EV[ev[1]]) : new Response("{}", { status: 404 });
      const tc = p.match(/^\/v3\/events\/(\d+)\/ticket_classes\/$/);
      if (tc && m === "GET") return json({ ticket_classes: TC[tc[1]] ?? [], pagination: { has_more_items: false } });
      const at = p.match(/^\/v3\/events\/(\d+)\/attendees\/$/);
      if (at && m === "GET") return json({ attendees: AT[at[1]] ?? [], pagination: { has_more_items: more[at[1]] === true } });
      const tm = p.match(/^\/v3\/events\/(\d+)\/teams\/$/);
      if (tm && m === "GET") return json({ teams: TEAMS[tm[1]] ?? [], pagination: { has_more_items: false } });
      const pub = p.match(/^\/v3\/events\/(\d+)\/publish\/$/);
      if (pub && m === "POST") return json({ published: true });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const publishes = () => hits.filter((h) => h.method === "POST" && /\/publish\/$/.test(h.path));
const SETTINGS: any = { business_name: "Test Events", event_ids: ["111", "222", "333"], publish_when_ready: true, run_sheet_days_ahead: 7, timezone: "Australia/Sydney" };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { EVENTBRITE_TOKEN: "eb-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot publish and a cron cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "eventbrite", op: "post:/events/{event_id}/publish/", input: { params: { event_id: "111" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "eventbrite", op: "get:/events/{event_id}/", summary: "x" }), /not a live operation/);
});

test("setup: a ready draft event is queued to publish and nothing is published by the cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await setup(ctx), { ready: 1, queued: 1, waiting: 0 });
  assert.equal(publishes().length, 0, "the cron never publishes");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  assert.equal(aps[0].acts[0].op, "post:/events/{event_id}/publish/");
  assert.equal(aps[0].acts[0].input?.params?.event_id, "111");
});

test("setup: re-runs never queue the same publish twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx); await setup(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
});

test("setup: publish_when_ready false reports only and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...SETTINGS, publish_when_ready: false }, store, NOW, () => {});
  assert.deepEqual(await setup(ctx), { ready: 1, queued: 0, waiting: 0 });
  assert.equal(Object.values(await store.list("approvals")).length, 0);
});

test("setup: an event with no ticket type waits and is not queued", async () => {
  TC["111"] = [];
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await setup(ctx), { ready: 0, queued: 0, waiting: 1 });
  assert.equal(Object.values(await store.list("approvals")).length, 0);
  TC["111"] = [{ id: "9100", name: "General" }];
});

test("approval: an approved publish runs once, and only then reaches the platform", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(publishes().length, 1);
  assert.equal(publishes()[0].path, "/v3/events/111/publish/");
});

test("approval: with writes blocked on the deploy, an approved publish fails and sends nothing", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "failed");
  assert.equal(publishes().length, 0);
});

test("registrations: attendees are kept without email addresses, and the cursor advances", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  const out = await registrations(ctx) as any;
  assert.equal(out.incomplete, 0);
  const row = await store.get<any>("register", "222-9002");
  assert.equal(row.checked_in, true);
  assert.equal(row.name, "Sam Test");
  assert.ok(!JSON.stringify(await store.list("register")).includes("@example.com"), "no email addresses in the register");
  assert.deepEqual(await store.get("cursor", "attendees-222"), { changed_since: "2026-11-07T11:00:00Z" });
  assert.equal(writes().length, 0, "registrations only read");
});

test("registrations: a partial page is flagged and the cursor does not advance", async () => {
  more["222"] = true;
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  const out = await registrations(ctx) as any;
  assert.equal(out.incomplete, 1);
  assert.equal(await store.get("cursor", "attendees-222"), undefined);
});

test("run-day: only the event inside the window is drafted, with its check-in teams", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await runDay(ctx), { drafted: 1, skipped: 2 });
  const sheet = await store.get<any>("run-sheets", "event-222");
  assert.deepEqual(sheet.teams, [{ name: "Check-in A", attendees: 2 }]);
  assert.equal(await store.get("run-sheets", "event-111"), undefined);
  assert.equal(writes().length, 0);
});

test("wrap-up: an ended event gets drafted counts per ticket type; events still running wait", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await wrapUp(ctx), { drafted: 1, waiting: 2, incomplete: 0 });
  const w = await store.get<any>("wrap-up", "event-333");
  assert.deepEqual(w.by_ticket.General, { sold: 2, checked_in: 2, cancelled: 1, refunded: 1 });
  assert.equal(writes().length, 0);
});

test("settings: a non-numeric event id is refused before any call", async () => {
  const ctx = context(WF, { ...SETTINGS, event_ids: ["abc"] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(setup(ctx), /bad id/);
  assert.equal(hits.length, 0);
});

test("crons: every entry in workflow.json has a function", () => {
  for (const c of WF.crons) assert.equal(typeof (CRONS as any)[c.entry], "function", c.entry);
});
