// Variations workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp } from "../industries/construction/workflows/sales/variations/index.ts";
import { main } from "../tools/workflow.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = "industries/construction/workflows/sales/variations";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const DAY = 864e5;
const JOB = "11111111-2222-4333-8444-555555555555", CO = "22222222-3333-4444-8555-666666666666";
const OLD = "33333333-4444-4555-8666-777777777777", NOTE = "44444444-5555-4666-8777-888888888888";
const REC = "55555555-6666-4777-8888-999999999999", NEWREC = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const MAT = "77777777-8888-4999-8aaa-bbbbbbbbbbbb", MAT2 = "88888888-9999-4aaa-8bbb-cccccccccccc";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...h } });
      if (p.endsWith("/job.json")) return json([{ uuid: JOB, active: 1, status: "Work Order", job_description: "Garden watering", job_address: "1 <Test> St", company_uuid: CO, generated_job_id: "J-1001", date: "2026-11-01" }]);
      if (p.endsWith("/note.json") && m === "POST") return json({ errorCode: 0 }, { "x-record-uuid": NEWREC });
      if (p.endsWith("/note.json")) return json([
        { uuid: OLD, active: 1, note: "Client prefers morning visits", create_date: "2026-11-01 09:00:00" },
        { uuid: NOTE, active: 1, note: "Client wants extra sprinkler heads on the north garden, variation needed", create_date: "2026-11-08 10:00:00" },
        { uuid: REC, active: 1, note: "Variation record (kit): 2 lines, $132.00 ex GST, awaiting client approval", create_date: "2026-11-08 10:05:00" },
      ]);
      if (p.endsWith("/material.json")) return json([{ uuid: MAT, item_number: "LAB-HR", name: "Labour hour", price: "95", active: 1 }, { uuid: MAT2, item_number: "IRR-HEAD", name: "Sprinkler head", price: "18.50", active: 1 }]);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", mobile: "0412 345 678", is_primary_contact: "1" }]);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const notes = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/note.json"));
const S: any = { business_name: "Test Contractors", variation_templates: [{ match: "sprinkler", lines: [{ code: "IRR-HEAD", qty: 2 }, { code: "LAB-HR", qty: 1 }] }], follow_up: { after_days: [3, 7] } };
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot send, and a cron cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.createNotes", summary: "x" }), /not a live operation/);
});

test("the SDK gate still blocks the job note when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "servicem8-api.createNotes", input: { body: { related_object: "job", related_object_uuid: JOB, note: "x" } }, summary: "x" }), WriteBlocked);
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});

test("intake reads the variation note on an accepted job, skips unrelated notes and the kit's own record, and adds it once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(Object.keys(await store.list("enquiries")), [`servicem8:note:${NOTE}`]);
  assert.deepEqual(await intake(ctx), { added: 0 });
});

test("draft prices from the template, writes one job note, queues the client email, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].body.related_object_uuid, JOB);
  assert.match(notes()[0].body.note, /^Variation record \(kit\): 2 lines, awaiting client approval$/);
  assert.ok(!/[$]|GST/.test(notes()[0].body.note), "the job note carries no price: job notes may show to the client");
  const pending = await main(["approvals", DIR], store) as any[];
  assert.equal(pending.length, 1);
  await draft(ctx); await intake(ctx);
  assert.equal(notes().length, 1, "a re-run never writes a second job note");
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 1, "re-runs never queue twice");
});

test("a variation with no template is parked, then priced from the agent's proposal", async () => {
  const store = new MemoryStore(), ctx = context(WF, { ...S, variation_templates: [] }, store, NOW, () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "variations-"));
  const lines = path.join(dir, "lines.json");
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 });
  fs.writeFileSync(lines, JSON.stringify([{ code: "LAB-HR", qty: 1 }, { code: "NOPE", qty: 1 }]));
  await main(["propose", DIR, `servicem8:note:${NOTE}`, lines], store);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 1 }, "an unknown code keeps it parked");
  fs.writeFileSync(lines, JSON.stringify([{ code: "LAB-HR", qty: 1, unitPrice: 80 }]));
  await main(["propose", DIR, `servicem8:note:${NOTE}`, lines], store);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_pricing: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("approval sends the client email once; follow-ups come due after the set days, once each, then stop", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const email = sends()[0].body;
  assert.equal(email.to, "sam@example.com");
  assert.equal(email.regardingJobUUID, JOB);
  assert.ok(!email.htmlBody.includes("<Test>"), "the job address is escaped");
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);

  assert.deepEqual(await followUp(context(WF, S, store, NOW, () => {})), { queued: 0 }, "not due yet");
  const day4 = new Date(NOW.getTime() + 4 * DAY);
  assert.deepEqual(await followUp(context(WF, S, store, day4, () => {})), { queued: 1 });
  assert.deepEqual(await followUp(context(WF, S, store, day4, () => {})), { queued: 0 }, "a second run the same day queues nothing");
  const day8 = new Date(NOW.getTime() + 8 * DAY);
  assert.deepEqual(await followUp(context(WF, S, store, day8, () => {})), { queued: 1 });
  assert.deepEqual(await followUp(context(WF, S, store, new Date(NOW.getTime() + 30 * DAY), () => {})), { queued: 0 }, "no more after the set count");
  assert.equal((await main(["approvals", DIR], store) as any[]).length, 2, "two follow-ups waiting for approval");
});
