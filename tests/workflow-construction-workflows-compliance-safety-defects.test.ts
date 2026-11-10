// Defects workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { logDefects, chase, closeOut } from "../industries/construction/workflows/compliance-safety/defects/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";

const DIR = "industries/construction/workflows/compliance-safety/defects";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const EXAMPLE = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const SETTINGS: any = {
  family: "defects-on-jobs", defect_section: "Defects", first_reminder_after_days: 1, reminder_every_days: 3,
  trade_contacts: [
    { match: "tile", name: "Tile Co", email: "office@tile.example.com.au" },
    { match: "plumb", name: "Plumb Co", email: "office@plumb.example.com.au" },
  ],
};
const JOB = "11111111-2222-4333-8444-555555555555", CO = "87654321-4321-4321-8321-210987654321";
const D1 = "aaaaaaaa-0000-4000-8000-000000000001", D2 = "aaaaaaaa-0000-4000-8000-000000000002", SAFE = "bbbbbbbb-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-09T00:00:00Z"), DAY = 864e5;
const LATER = new Date(NOW.getTime() + 2 * DAY);

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [], items: any[] = [], taskSeq = 0;

function fake() {
  hits = []; taskSeq = 0;
  items = [
    { uuid: D1, job_uuid: JOB, section_name: "Defects", name: "Cracked tile in bathroom", active: 1, completed_timestamp: "0000-00-00 00:00:00" },
    { uuid: D2, job_uuid: JOB, section_name: "Defects", name: "Plumbing leak under sink", active: 1, completed_timestamp: "0000-00-00 00:00:00" },
    { uuid: SAFE, job_uuid: JOB, section_name: "Safety", name: "Harness checked", active: 1, completed_timestamp: "2026-11-09 08:00:00" },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      const f = u.searchParams.get("$filter") ?? "";
      if (p.endsWith("/job.json")) return json([{ uuid: JOB, status: "Work Order", active: 1, job_address: "1 Test St", company_uuid: CO }]);
      if (p.endsWith("/jobchecklist.json")) return json(items.filter((i) => f.includes(`'${i.job_uuid}'`)));
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }]);
      if (p.endsWith("/task.json") && m === "POST") return json({ errorCode: 0 }, { "x-record-uuid": `cccccccc-0000-4000-8000-${String(++taskSeq).padStart(12, "0")}` });
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const tasks = () => hits.filter((h) => h.path.endsWith("/task.json") && h.method === "POST");
const open = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation, and cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createTasks", summary: "x" }), /not a live operation/);
});

test("log-defects: each defect is recorded once with one task, the safety item is ignored, nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await logDefects(ctx), { logged: 2, tasks: 2 });
  assert.deepEqual(await logDefects(ctx), { logged: 0, tasks: 0 });
  assert.equal(tasks().length, 2);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal((await store.get<any>("defects", SAFE)), undefined);
  assert.equal((await store.get<any>("defects", D1)).task_ref, "cccccccc-0000-4000-8000-000000000001");
});

test("chase: a due reminder is queued for approval, re-runs queue nothing new, the approved email goes once", async () => {
  const store = new MemoryStore();
  await logDefects(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(await chase(context(WF, SETTINGS, store, NOW, () => {})), { queued: 0, no_trade_contact: 0 }, "not due on the day logged");
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 2, no_trade_contact: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const pending = (await open(store)).filter((a) => a.status === "pending");
  assert.equal(pending.length, 2);
  assert.deepEqual(await chase(context(WF, SETTINGS, store, LATER, () => {})), { queued: 0, no_trade_contact: 0 });
  assert.equal((await open(store)).length, 2, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", LATER);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.ok(["office@tile.example.com.au", "office@plumb.example.com.au"].includes(sends()[0].body.to));
  assert.equal(sends()[0].body.regardingJobUUID, JOB);
  await assert.rejects(approve(WF, store, pending[0].id, "owner", LATER), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("close-out: when every defect is fixed, one sign-off task and one client email are queued, and only once", async () => {
  const store = new MemoryStore();
  await logDefects(context(WF, SETTINGS, store, NOW, () => {}));
  items[0].completed_timestamp = "2026-11-10 14:00:00";
  items[1].completed_timestamp = "2026-11-10 15:00:00";
  assert.deepEqual(await closeOut(context(WF, SETTINGS, store, LATER, () => {})), { tasks: 1, sign_off_queued: 1 });
  assert.equal(tasks().length, 3, "two defect tasks and one sign-off task");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.deepEqual(await closeOut(context(WF, SETTINGS, store, LATER, () => {})), { tasks: 0, sign_off_queued: 0 });
  const [ap] = await open(store);
  assert.equal((await open(store)).length, 1);
  await approve(WF, store, ap.id, "owner", LATER);
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.to, "sam@example.com");
});

test("a job id that is not a UUID never reaches a filter", async () => {
  const { servicem8 } = await import("../industries/construction/workflows/compliance-safety/defects/adapters/servicem8.ts");
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(servicem8.defectItems!(ctx, "x' or 1=1"), /bad uuid/);
  assert.equal(hits.length, 0);
});

test("deploy: every target renders every cron, with no key values", () => {
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, EXAMPLE, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/s8|Bearer [A-Za-z0-9]{8}/.test(all.replace(/SERVICEM8|kit|Bearer \$|Bearer \\\$|Bearer ' \|\||Bearer \${/g, "")), `${t} carries no key values`);
  }
});
