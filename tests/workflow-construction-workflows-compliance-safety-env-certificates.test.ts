// Solar and electrical paperwork tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, evidence, chase } from "../industries/construction/workflows/compliance-safety/env-certificates/index.ts";
import fs from "node:fs";

const DIR = "industries/construction/workflows/compliance-safety/env-certificates";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SOLAR = "11111111-2222-4333-8444-555555555555", DRAIN = "22222222-3333-4444-8555-666666666666";
const COMPANY = "cccccccc-dddd-4eee-8fff-000000000001";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname, filter = u.searchParams.get("$filter") ?? "";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/job.json")) return json([
        { uuid: SOLAR, status: "Work Order", active: 1, job_description: "6.6 kW solar install, 5 kW inverter", job_address: "1 Test St", company_uuid: COMPANY, work_done_description: "" },
        { uuid: DRAIN, status: "Quote", active: 1, job_description: "Blocked drain at the back", job_address: "2 Test St", company_uuid: COMPANY, work_done_description: "" },
      ]);
      if (p.endsWith("/attachment.json")) return json(filter.includes(SOLAR)
        ? [{ attachment_name: "CES certificate.pdf", file_type: ".pdf", related_object_uuid: SOLAR }]
        : []);
      if (p.endsWith("/companycontact.json")) return json([{ first: "Sam", last: "Lee", email: "sam@example.com", is_primary_contact: "1" }]);
      if (p.endsWith("/platform_service_email")) return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/platform_service_email"));
const S: any = { business_name: "Test Solar", intake: "servicem8", chase_every_days: 3,
  keywords: ["solar", "inverter", "network connection", "stc"],
  evidence: { "installation photos": ["jpg"], "electrical safety certificate": ["certificate"], "serial numbers": ["serial"] } };
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SERVICEM8_API_KEY: "s8", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.listJobs", summary: "x" }), /not a live operation/);
});

test("register tracks only the paperwork job, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { added: 1 });
  assert.ok(await store.get("jobs", SOLAR));
  assert.equal(await store.get("jobs", DRAIN), undefined, "a drain job is not paperwork");
  assert.deepEqual(await register(ctx), { added: 0 }, "re-runs never track twice");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("evidence records what is missing; a certificate on file clears that item only", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx);
  assert.deepEqual(await evidence(ctx), { checked: 1, missing: 1 });
  const t = await store.get<any>("jobs", SOLAR);
  assert.deepEqual(t.missing.sort(), ["installation photos", "serial numbers"]);
});

test("chase queues one email per job for approval; approval sends it; re-runs never queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await register(ctx); await evidence(ctx);
  assert.deepEqual(await chase(ctx), { queued: 1 });
  assert.equal(sends().length, 0, "the chase cron never sends");
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { queued: 0 }, "not chased again inside the interval");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  const ap = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.to, "sam@example.com");
  assert.equal(sends()[0].body.regardingJobUUID, SOLAR);
});
