// Safety workflow, Procore side (incidents and inspections). Every request goes to a fake network: no test reaches a real Procore account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { incidents, inspectionReminders, prestart } from "../industries/construction/workflows/compliance-safety/safety/index.ts";

const DIR = "industries/construction/workflows/compliance-safety/safety";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { procore: { projects: [{ id: "4242", name: "12 Smith St" }], reminder_distribution_ids: ["134", "456"] } };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; query: URLSearchParams; body: any; headers: Headers };
let hits: Hit[] = [];
let showStatus = "Open";
let inc: any[] = [], insp: any[] = [], incBody: (page: number) => any = (p) => (p === 1 ? inc : []);

function fake() {
  hits = [];
  inc = [
    { id: 11, title: "Slip on stairs", status: "open", recordable: true, event_date: "2026-11-07T01:00:00Z", number: 3, deleted_at: null },
    { id: 12, title: "Near miss, crane", status: "closed", recordable: false, event_date: "2026-11-01T01:00:00Z", number: 2, deleted_at: null },
    { id: 13, title: "Removed", status: "open", recordable: false, deleted_at: "2026-11-05T00:00:00Z" },
  ];
  insp = [
    { id: 21, name: "Scaffold check", identifier: "INS-21", status: "Open", due_at: "2026-11-05T00:00:00Z", deleted: false, deficient_item_count: 2 },
    { id: 22, name: "Crane check", identifier: "INS-22", status: "Closed", due_at: "2026-11-01T00:00:00Z", deleted: false, deficient_item_count: 0 },
    { id: 23, name: "Future check", identifier: "INS-23", status: "In Review", due_at: "2026-12-01T00:00:00Z", deleted: false },
    { id: 24, name: "Gone", identifier: "INS-24", status: "Open", due_at: "2026-11-01T00:00:00Z", deleted: true },
  ];
  incBody = (p) => (p === 1 ? inc : []);
  showStatus = "Open";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body, headers: new Headers(init?.headers) });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.procore.com") return new Response("wrong host", { status: 404 });
      const page = Number(u.searchParams.get("page") ?? 1);
      if (p === "/rest/v1.0/projects/4242/incidents" && m === "GET") return json(incBody(page));
      if (/^\/rest\/v1\.0\/projects\/4242\/checklist\/lists\/\d+$/.test(p) && m === "GET") return json({ id: 21, status: showStatus });
      if (p === "/rest/v1.0/projects/4242/checklist/lists" && m === "GET") return json(page === 1 ? insp : []);
      if (/^\/rest\/v1\.0\/projects\/4242\/checklist\/lists\/\d+\/send_email$/.test(p) && m === "POST") return new Response(null, { status: 204 });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PROCORE_ACCESS_TOKEN: "pc-token", PROCORE_COMPANY_ID: "777", KIT_ALLOW_WRITES: "1" });
});

test("runtime: the inspection email is live only, the lists are draft only", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "procore", op: "checklists.send-checklist-inspection-email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "procore", op: "incidents.list-incidents", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("incidents: records each once, flags new open and recordable, skips deleted, writes nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await incidents(ctx), { new_open: 1, recordable: 1, closed: 0 });
  assert.ok(await store.get("incidents", "4242:11")); assert.ok(await store.get("incidents", "4242:12"));
  assert.equal(await store.get("incidents", "4242:13"), undefined, "a deleted incident is not recorded");
  assert.equal(writes().length, 0);
  assert.equal(hits[0].headers.get("procore-company-id"), "777");
  assert.deepEqual(await incidents(ctx), { new_open: 0, recordable: 0, closed: 0 }, "a rerun reports nothing new");
});

test("incidents: an incident that closes later is counted once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await incidents(ctx);
  inc[0].status = "closed";
  assert.equal((await incidents(ctx) as any).closed, 1);
  assert.equal((await incidents(ctx) as any).closed, 0);
});

test("incidents: no procore settings reads nothing", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await incidents(ctx), { new_open: 0, recordable: 0 });
  assert.equal(hits.length, 0);
});

test("incidents: a non-list reply, a row with no id and a project past 20 pages each refuse the whole read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  incBody = () => ({ error: "x" } as any);
  await assert.rejects(incidents(ctx), /did not come back as a list/);
  incBody = (p) => (p === 1 ? [{ title: "no id", status: "open" }] : []);
  await assert.rejects(incidents(ctx), /no usable id/);
  incBody = (p) => [{ id: p, title: "t", status: "closed" }];
  await assert.rejects(incidents(ctx), /longer than 20 pages/);
});

test("inspections: queues one email for the overdue open inspection only, nothing sent before approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await inspectionReminders(ctx), { overdue: 1 });
  assert.equal(writes().length, 0, "queued, not sent");
  assert.match(Object.values(await store.list<Approval>("approvals"))[0].summary, /inspection "INS-21 Scaffold check" on 12 Smith St is past due/);
  assert.deepEqual(await inspectionReminders(ctx), { overdue: 0 }, "once per due date");
});

test("inspections: approving sends the email with the integer ids and the Procore company header", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await inspectionReminders(ctx);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  await approve(WF, store, pending[0].id, "owner", NOW);
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].path, "/rest/v1.0/projects/4242/checklist/lists/21/send_email");
  assert.deepEqual(w[0].body.distribution_ids, [134, 456]);
  assert.match(w[0].body.subject, /INS-21 Scaffold check/); assert.match(w[0].body.body, /2 deficient items/);
  assert.equal(w[0].headers.get("procore-company-id"), "777");
});

test("inspections: no distribution ids set queues nothing and reads nothing", async () => {
  const ctx = context(WF, { procore: { projects: SETTINGS.procore.projects } }, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await inspectionReminders(ctx), { overdue: 0 });
  assert.equal(hits.length, 0);
});

test("a bad project id is refused before any call, and the SiteBook prestart still skips without its own settings", async () => {
  const ctx = context(WF, { procore: { projects: [{ id: "../x", name: "bad" }], reminder_distribution_ids: ["1"] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(incidents(ctx), /bad id/);
  assert.equal(hits.length, 0);
  assert.deepEqual(await prestart(context(WF, SETTINGS, new MemoryStore(), NOW, () => {})), { created: 0, attached: 0 });
});

test("incidents: a second page is read, and the per_page sent is the documented 1000", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  incBody = (p) => (p === 1 ? [{ id: 31, title: "a", status: "open" }] : p === 2 ? [{ id: 32, title: "b", status: "open" }] : []);
  assert.equal((await incidents(ctx) as any).new_open, 2);
  assert.equal(hits[0].query.get("per_page"), "1000"); assert.equal(hits.length, 3);
});

test("incidents: one project failing does not stop the next being read, and the run still fails loudly", async () => {
  const two: any = { procore: { projects: [{ id: "9999", name: "Bad" }, { id: "4242", name: "Good" }] } };
  const store = new MemoryStore(), ctx = context(WF, two, store, NOW, () => {});
  await assert.rejects(incidents(ctx), /1 project\(s\) not read/);
  assert.ok(await store.get("incidents", "4242:11"), "the good project was still recorded");
});

test("incidents: the log line carries the incident number, never the title", async () => {
  const lines: string[] = [], ctx = context(WF, SETTINGS, new MemoryStore(), NOW, (m: string) => lines.push(m));
  await incidents(ctx);
  assert.ok(lines.some((l) => /new open incident #3/.test(l))); assert.ok(!lines.some((l) => /Slip on stairs/.test(l)));
});

test("inspections: an approval given after the inspection was closed in Procore sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await inspectionReminders(ctx);
  showStatus = "Closed";
  const pending = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(writes().length, 0, "the email was not sent");
  assert.equal(((await store.get<Approval>("approvals", pending[0].id)) as any).status, "rejected");
});

test("inspections: a bad distribution id refuses the setting rather than dropping the recipient", async () => {
  const ctx = context(WF, { procore: { projects: SETTINGS.procore.projects, reminder_distribution_ids: ["134", "456 "] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(inspectionReminders(ctx), /must be Procore integer ids/);
  assert.equal(hits.length, 0);
});

test("more than 100 projects in settings is refused, not truncated", async () => {
  const many: any = { procore: { projects: Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), name: "p" })) } };
  await assert.rejects(incidents(context(WF, many, new MemoryStore(), NOW, () => {})), /more than 100 projects/);
});
