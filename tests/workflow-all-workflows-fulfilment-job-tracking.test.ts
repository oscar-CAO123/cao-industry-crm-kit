// Job-tracking workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, progress, closeOut, CRONS } from "../industries/all/workflows/fulfilment/job-tracking/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const WF_PATH = "industries/all/workflows/fulfilment/job-tracking";
const WF = JSON.parse(fs.readFileSync(`${WF_PATH}/workflow.json`, "utf8")) as WorkflowRecord;
const JOB = "11111111-2222-4333-8444-555555555555", CO = "87654321-4321-4321-8321-210987654321";
const WS = "1200000000000000", PROJ = "1200000000000001";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any; query: URLSearchParams };
let hits: Hit[] = [];
let s8Status = "Work Order", s8Edit = "2026-11-05 03:00:00", s8Desc = "Hot water system leaking";
let asanaDone = 1;

function fake() {
  hits = []; s8Status = "Work Order"; s8Edit = "2026-11-05 03:00:00"; s8Desc = "Hot water system leaking"; asanaDone = 1;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body, query: u.searchParams });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // ServiceM8
      if (p.endsWith("/job.json")) {
        const f = u.searchParams.get("$filter") ?? "";
        return json(f === `status eq 'Work Order'` ? [{ uuid: JOB, status: "Work Order", active: 1, job_description: s8Desc, job_address: "1 Test St", company_uuid: CO, edit_date: s8Edit }] : []);
      }
      if (p.endsWith(`/job/${JOB}.json`) && m === "GET") return json({ uuid: JOB, status: s8Status, edit_date: s8Edit, active: 1 });
      if (p.endsWith("/companycontact.json")) return json([{ company_uuid: CO, first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }]);
      if (p.endsWith("/note.json")) return json({ errorCode: 0 });
      if (p.endsWith("/platform_service_email") || p.endsWith("/platform_service_sms")) return json({ errorCode: 0 });
      // Asana
      if (p.endsWith(`/workspaces/${WS}/projects`)) return json({ data: [{ gid: PROJ, name: "Warehouse fit-out" }, { gid: "../bad", name: "Injected" }] });
      if (p.endsWith(`/projects/${PROJ}/task_counts`)) return json({ data: { num_tasks: 3, num_completed_tasks: asanaDone, num_incomplete_tasks: 3 - asanaDone } });
      if (p.endsWith(`/projects/${PROJ}/tasks`)) return json({ data: [{ gid: "1", name: "Pipe run", modified_at: "2026-11-05T00:00:00.000Z" }] });
      if (p.endsWith("/tasks") && m === "POST") return json({ data: { gid: "2" } });
      if (p.endsWith(`/projects/${PROJ}/project_statuses`) && m === "POST") return json({ data: { gid: "3" } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET");
const sends = () => hits.filter((h) => /platform_service_(email|sms)$|project_statuses$/.test(h.path));
const notes = () => hits.filter((h) => h.path.endsWith("/note.json") || (h.path.endsWith("/tasks") && h.method === "POST"));

const S8: any = { family: "dispatched-field-jobs", business_name: "Test Services", intake: ["servicem8"], servicem8: { client_channel: "email" }, stall_days: 5, client_update_days: 7 };
const BOTH: any = { ...S8, intake: ["servicem8", "asana"], asana: { workspace_gid: WS } };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8-secret-value-123", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", ASANA_ACCESS_TOKEN: "as-secret-value-456", KIT_ALLOW_WRITES: "1" });
});

test("workflow record: no live operation is also a draft operation, and every cron has an entry", () => {
  for (const p of Object.keys(WF.live_ops)) {
    for (const op of WF.live_ops[p]) assert.ok(!(WF.draft_ops[p] ?? []).includes(op), `${p} ${op} is in both lists`);
  }
  for (const c of WF.crons) assert.ok(c.entry in CRONS, `${c.entry} is exported`);
});

test("intake: open jobs and projects go on the record once each, with no write to either platform", async () => {
  const store = new MemoryStore(), ctx = context(WF, BOTH, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await intake(context(WF, BOTH, store, NOW, () => {})), { added: 0 }, "re-runs add nothing");
  assert.equal(writes().length, 0, "intake only reads");
  assert.equal(hits.some((h) => h.path.includes("%2e%2e") || h.path.includes("../bad")), false, "a bad project id is never used");
});

test("progress: a stalled job gets one draft note; the note repeats only after the job moves", async () => {
  const store = new MemoryStore();
  s8Edit = "2026-10-20 09:00:00";
  await intake(context(WF, S8, store, NOW, () => {}));
  assert.deepEqual(await progress(context(WF, S8, store, NOW, () => {})), { stalled: 1, queued: 0 });
  assert.equal(notes().length, 1, "one internal note");
  assert.deepEqual(await progress(context(WF, S8, store, NOW, () => {})), { stalled: 0, queued: 0 }, "not noted again");
  assert.equal(notes().length, 1);
  assert.equal(sends().length, 0, "nothing reaches the client");
  s8Edit = "2026-11-07 09:00:00";
  assert.deepEqual(await progress(context(WF, S8, store, NOW, () => {})), { stalled: 0, queued: 0 }, "a job that moved on is no longer stalled");
  assert.equal(notes().length, 1);
});

test("progress: new progress after the message window queues one client email, which runs only on approval, once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S8, store, new Date("2026-11-01T00:00:00Z"), () => {}));
  // Six days after intake is inside the seven-day message window, so nothing is queued yet.
  assert.deepEqual(await progress(context(WF, S8, store, new Date("2026-11-07T00:00:00Z"), () => {})), { stalled: 0, queued: 0 });
  const later = new Date("2026-11-09T00:00:00Z");
  s8Edit = "2026-11-08 06:00:00";
  assert.deepEqual(await progress(context(WF, S8, store, later, () => {})), { stalled: 0, queued: 1 });
  assert.equal(sends().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "messaging-api.send_email");
  assert.equal(ap.acts[0].platform, "servicem8");
  assert.deepEqual(await progress(context(WF, S8, store, later, () => {})), { stalled: 0, queued: 0 }, "re-run queues nothing");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  await approve(WF, store, ap.id, "owner", later);
  assert.equal(sends().length, 1, "sent once, on approval");
  assert.equal(sends()[0].body.to, "sam@example.com");
  assert.equal(sends()[0].body.regardingJobUUID, JOB);
  await assert.rejects(approve(WF, store, ap.id, "owner", later), /already done/);
});

test("client messages escape job text: a hostile description cannot inject markup", async () => {
  s8Desc = `<img src=x onerror="alert(1)"> Hot water`;
  const store = new MemoryStore();
  await intake(context(WF, S8, store, new Date("2026-11-01T00:00:00Z"), () => {}));
  s8Edit = "2026-11-08 06:00:00";
  await progress(context(WF, S8, store, new Date("2026-11-09T00:00:00Z"), () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const html = String(ap.acts[0].input?.body?.htmlBody ?? "");
  assert.ok(!html.includes("<img"), "no raw tag");
  assert.ok(html.includes("&lt;img"), "escaped");
});

test("subjects carry one line of job text: a line break in a job description cannot start a new header", async () => {
  s8Desc = "Hot water\r\nBcc: someone@example.com";
  const store = new MemoryStore();
  await intake(context(WF, S8, store, new Date("2026-11-01T00:00:00Z"), () => {}));
  s8Edit = "2026-11-08 06:00:00";
  await progress(context(WF, S8, store, new Date("2026-11-09T00:00:00Z"), () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const subject = String(ap.acts[0].input?.body?.subject ?? "");
  assert.doesNotMatch(subject, /[\u0000-\u001f\u007f]/, "no control characters in the subject");
  assert.ok(subject.includes("Hot water"), "the job text is still there");
});

test("close-out: a completed ServiceM8 job gets a draft note and a queued completion email, then closes once", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S8, store, NOW, () => {}));
  s8Status = "Completed";
  assert.deepEqual(await closeOut(context(WF, S8, store, NOW, () => {})), { closed: 1 });
  assert.equal(notes().length, 1, "one internal note");
  assert.equal(sends().length, 0, "completion message only queued");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, "messaging-api.send_email");
  assert.deepEqual(await closeOut(context(WF, S8, store, NOW, () => {})), { closed: 0 }, "closed jobs are skipped");
  assert.equal(notes().length, 1, "no second note");
});

test("Asana project: task counts drive status; completion queues a project status and only a follower notice on approval", async () => {
  const store = new MemoryStore();
  await intake(context(WF, BOTH, store, NOW, () => {}));
  assert.equal(writes().filter((h) => h.path.endsWith("/tasks")).length, 0, "no task written on intake");

  asanaDone = 3;
  assert.deepEqual(await closeOut(context(WF, BOTH, store, NOW, () => {})), { closed: 1 }, "only the Asana project is complete");
  const tasks = hits.filter((h) => h.path.endsWith("/tasks") && h.method === "POST");
  assert.equal(tasks.length, 1, "internal note is a task in the project");
  assert.deepEqual(tasks[0].body.data.projects, [PROJ]);
  assert.equal(sends().length, 0, "no project status yet");

  const aps = Object.values(await store.list<Approval>("approvals"));
  const ap = aps.find((a) => a.acts[0].platform === "asana")!;
  assert.equal(ap.acts[0].op, "createProjectStatusForProject");
  await approve(WF, store, ap.id, "owner", NOW);
  const status = hits.find((h) => h.path.endsWith(`/projects/${PROJ}/project_statuses`) && h.method === "POST")!;
  assert.equal(status.body.data.color, "green");
  assert.match(status.body.data.title, /Warehouse fit-out/);
});

test("deploy: every target renders every cron without carrying key values", () => {
  for (const t of TARGETS) {
    const files = render(WF_PATH, S8, t);
    const all = Object.values(files).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!all.includes("s8-secret-value-123") && !all.includes("as-secret-value-456"), `${t} carries no key values`);
  }
});
