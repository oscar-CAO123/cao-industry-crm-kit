// Booking workflow tests (all industries, sales: booking-reminders). Every request goes to a fake Calendly: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, noShow, CRONS } from "../industries/all/workflows/sales/booking-reminders/index.ts";
import { READ_EVENTS, NO_SHOW } from "../industries/all/workflows/sales/booking-reminders/adapters/calendly.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import { main } from "../tools/workflow.ts";

const DIR = "industries/all/workflows/sales/booking-reminders";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const USER = "https://api.calendly.com/users/11111111-aaaa-4bbb-8ccc-222222222222";
const SETTINGS: any = { business_name: "Test Clinic", intake: ["calendly"], calendly: { user_uri: USER, lookahead_days: 14, no_show_grace_minutes: 15 } };
const T0 = new Date("2026-11-08T07:00:00Z");   // intake runs before the appointments
const T1 = new Date("2026-11-08T10:00:00Z");   // the no-show cron runs after them

const E_PAST = "3f2a1b00-0000-4000-8000-000000000001";   // 08:00 to 09:00: finished, outside grace
const E_RECENT = "3f2a1b00-0000-4000-8000-000000000002"; // 09:30 to 09:55: finished, inside the 15 minute grace
const E_FUTURE = "3f2a1b00-0000-4000-8000-000000000003"; // 12:00 to 12:30
const ev = (uuid: string) => `https://api.calendly.com/scheduled_events/${uuid}`;
const inv = (event: string, uuid: string) => `${ev(event)}/invitees/${uuid}`;
const I_NOSHOW = inv(E_PAST, "4a000000-0000-4000-8000-000000000001");
const I_CANCELLED = inv(E_PAST, "4a000000-0000-4000-8000-000000000002");
const I_MARKED = inv(E_PAST, "4a000000-0000-4000-8000-000000000003");
const I_RECENT = inv(E_RECENT, "4a000000-0000-4000-8000-000000000004");
const I_FUTURE = inv(E_FUTURE, "4a000000-0000-4000-8000-000000000005");

const EVENTS = [
  { uri: ev(E_PAST), name: "Physio consult", start_time: "2026-11-08T08:00:00.000000Z", end_time: "2026-11-08T09:00:00.000000Z", status: "active" },
  { uri: ev(E_RECENT), name: "Massage", start_time: "2026-11-08T09:30:00.000000Z", end_time: "2026-11-08T09:55:00.000000Z", status: "active" },
  { uri: ev(E_FUTURE), name: "Assessment", start_time: "2026-11-08T12:00:00.000000Z", end_time: "2026-11-08T12:30:00.000000Z", status: "active" },
];
const person = (uri: string, name: string, email: string, status = "active", noShowUri?: string) => ({
  uri, name, email, status, no_show: noShowUri ? { uri: noShowUri, created_at: "2026-11-08T09:10:00Z" } : null,
});
const INVITEES: Record<string, any[]> = {
  [E_PAST]: [person(I_NOSHOW, "Ana Lee", "ana@example.com"), person(I_CANCELLED, "Cam Ong", "cam@example.com", "canceled"),
             person(I_MARKED, "Eli Park", "eli@example.com", "active", "https://api.calendly.com/invitee_no_shows/OLD1")],
  [E_RECENT]: [person(I_RECENT, "Ben Ng", "ben@example.com")],
  [E_FUTURE]: [person(I_FUTURE, "Dee Ray", "dee@example.com")],
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let cancelled = new Set<string>();
let posted: any[] = [];

function fake() {
  hits = []; cancelled = new Set(); posted = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/scheduled_events" && m === "GET") {
        const min = Date.parse(u.searchParams.get("min_start_time") ?? ""), max = Date.parse(u.searchParams.get("max_start_time") ?? "");
        const collection = EVENTS.filter((e) => Date.parse(e.start_time) >= min && Date.parse(e.start_time) <= max);
        return json({ collection, pagination: { count: collection.length, next_page: null } });
      }
      const invs = /^\/scheduled_events\/([^/]+)\/invitees$/.exec(p);
      if (invs && m === "GET") {
        const collection = (INVITEES[invs[1]] ?? []).map((i) => (cancelled.has(i.uri) ? { ...i, status: "canceled" } : i));
        return json({ collection, pagination: { count: collection.length, next_page: null } });
      }
      if (p === "/invitee_no_shows" && m === "POST") {
        posted.push(body);
        return json({ resource: { uri: "https://api.calendly.com/invitee_no_shows/NS1", invitee: body?.invitee, created_at: "2026-11-08T10:00:00Z" } }, 201);
      }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { CALENDLY_API_TOKEN: "cal-test-token", KIT_ALLOW_WRITES: "1" });
});

test("crons are wired: the record's cron entries are the functions in CRONS", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "booking-reminders");
});

test("runtime: a no-show mark is a live operation only, and a read is never queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), T1, () => {});
  await assert.rejects(ctx.draft({ platform: "calendly", op: NO_SHOW, input: { body: { invitee: I_NOSHOW } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "calendly", op: READ_EVENTS, summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("settings are checked before any call: a bad user URI never reaches the network", async () => {
  const bad = { ...SETTINGS, calendly: { user_uri: "https://evil.example.com/users/x" } };
  await assert.rejects(intake(context(WF, bad, new MemoryStore(), T0, () => {})), /user_uri/);
  await assert.rejects(noShow(context(WF, bad, new MemoryStore(), T1, () => {})), /user_uri/);
  assert.equal(hits.length, 0);
});

test("intake reads the book and writes nothing to Calendly", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, SETTINGS, store, T0, () => {})), { added: 5, updated: 0 });
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "no write from intake");
  const b = await store.get<any>("bookings", `calendly:${I_CANCELLED.split("/").pop()}`);
  assert.equal(b.status, "canceled");
  assert.deepEqual(await intake(context(WF, SETTINGS, store, T0, () => {})), { added: 0, updated: 5 });
});

test("no-show queues one yes-or-no for a finished booking outside the grace period, and nothing is sent by the cron", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, T0, () => {}));
  assert.deepEqual(await noShow(context(WF, SETTINGS, store, T1, () => {})), { queued: 1, skipped: 0 });
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "the cron never posts a no-show");
  const pending = await main(["approvals", DIR], store) as any[];
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /Ana Lee/);
  assert.match(pending[0].summary, /Approve to mark a no-show/);
});

test("re-runs never queue twice, and a rejected yes-or-no stays rejected", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, T0, () => {}));
  await noShow(context(WF, SETTINGS, store, T1, () => {}));
  await noShow(context(WF, SETTINGS, store, T1, () => {}));
  const [ap] = await main(["approvals", DIR], store) as any[];
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 1, "one approval after two runs");
  await reject(WF, store, ap.id, "owner", T1);
  await noShow(context(WF, SETTINGS, store, T1, () => {}));
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 0, "a rejected one is not queued again");
  assert.equal((await store.get<Approval>("approvals", ap.id))!.status, "rejected");
});

test("approval marks the no-show on Calendly with the invitee URI, once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, T0, () => {}));
  await noShow(context(WF, SETTINGS, store, T1, () => {}));
  const [ap] = await main(["approvals", DIR], store) as any[];
  const done = await approve(WF, store, ap.id, "owner", T1);
  assert.equal(done.status, "done");
  assert.deepEqual(posted, [{ invitee: I_NOSHOW }]);
  assert.equal(done.results?.[0]?.status, 201);
  await assert.rejects(approve(WF, store, ap.id, "owner", T1), /already done/);
  assert.equal(posted.length, 1, "posted once");
});

test("writes stay blocked when the deploy does not allow them: the approval fails and nothing is posted", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, T0, () => {}));
  await noShow(context(WF, SETTINGS, store, T1, () => {}));
  const [ap] = await main(["approvals", DIR], store) as any[];
  process.env.KIT_ALLOW_WRITES = "0";
  const r = await approve(WF, store, ap.id, "owner", T1);
  assert.equal(r.status, "failed");
  assert.equal(posted.length, 0);
});

test("a booking cancelled after intake is re-read and skipped, never queued", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, T0, () => {}));
  cancelled.add(I_NOSHOW);
  assert.deepEqual(await noShow(context(WF, SETTINGS, store, T1, () => {})), { queued: 0, skipped: 1 });
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 0);
});

test("deploy: every target schedules both crons, the runner targets name the Calendly key and never carry its value", () => {
  const RUNNERS = ["docker", "server", "railway", "aws", "gcp", "azure"];
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, SETTINGS, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    if (RUNNERS.includes(t)) assert.ok(all.includes("CALENDLY_API_TOKEN"), `${t} lists CALENDLY_API_TOKEN`);
    assert.ok(!all.includes("cal-test-token"), `${t} carries no key value`);
  }
});
