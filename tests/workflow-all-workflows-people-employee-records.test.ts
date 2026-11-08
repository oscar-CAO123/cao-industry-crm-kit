// Employee-records workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { hires, changes, reviews } from "../industries/all/workflows/people/employee-records/index.ts";
import type { Hire, Change, ReviewPlan } from "../industries/all/workflows/people/employee-records/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/people/employee-records/workflow.json", "utf8")) as WorkflowRecord;
const ORG = "11111111-2222-4333-8444-555555555555", ENT = "3a41ab5f-fd18-4c99-b475-040a098dac89", TPL = "c4a9e1b7-3f52-4d68-9a10-5b7e2d8f6a01";
const ACCT = "f0e1d2c3-b4a5-4968-8778-6a5b4c3d2e1f", EMP = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  business_name: "Test Builders",
  employment_hero: { organisation_id: ORG, employing_entity_id: ENT, work_location: { id: "b992fc49-7e98-4743-b53b-51bec9cf4dc3", name: "Sydney Office", country: "AU" } },
  docusign: { template_id: TPL, role_name: "Employee" },
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let privatePem = "";
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/oauth\/(token|userinfo)$/.test(h.path));

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      // DocuSign sign-in
      if (p.endsWith("/oauth/token")) return json({ access_token: "ds-token", expires_in: 3600 });
      if (p.endsWith("/oauth/userinfo")) return json({ accounts: [{ account_id: ACCT, base_uri: "https://demo.docusign.net" }] });
      // DocuSign eSignature
      if (p.endsWith(`/templates/${TPL}`) && m === "GET") return json({ templateId: TPL, name: "Contract" });
      if (p.endsWith("/envelopes") && m === "POST") return json({ envelopeId: "env-1", status: "sent" }, 201);
      // Employment Hero
      if (p.endsWith("/employees/quick_add_employee") && m === "POST") return json({ id: EMP, first_name: "Ari" }, 201);
      if (/\/employees\/emp-1$/.test(p) && m === "GET") return json({ id: "emp-1" });
      if (/\/employees\/emp-1\/employment_details$/.test(p) && m === "PATCH") return json({ id: "emp-1" });
      if (/\/employees\/emp-1\/pay_details\/salary_versions$/.test(p) && m === "POST") return json({ id: "sv-1" }, 201);
      if (p.endsWith("/performance_reviews") && m === "GET") return json([{ id: "pr-0" }]);
      if (p.endsWith("/performance_reviews") && m === "POST") return json({ id: "pr-1" }, 201);
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  if (!privatePem) privatePem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  Object.assign(process.env, {
    EMPLOYMENT_HERO_ACCESS_TOKEN: "eh-token", DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_USER_ID: "uid",
    DOCUSIGN_ACCOUNT_ID: ACCT, DOCUSIGN_PRIVATE_KEY: privatePem, KIT_ALLOW_WRITES: "1",
  });
});

const hire = (over: Partial<Hire> = {}): Hire => ({ id: "hire-1", first_name: "Ari", last_name: "Chen", email: "ari@example.com", status: "confirmed", ...over });

test("runtime: a cron cannot run a live operation as a read, and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "employment-hero", op: "Quick Add Employee Config", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "docusign", op: "esignature.Envelopes_PostEnvelopes", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "employment-hero", op: "Get Employee Config", summary: "x" }), /not a live operation/);
});

test("hire: the employee record is queued, never sent by a cron; the contract waits for the record and for approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("hires", "hire-1", hire());
  assert.deepEqual(await hires(ctx), { queued: 1, contracts: 0 });
  assert.equal(writes().length, 0, "nothing written by a cron");
  assert.deepEqual(await hires(ctx), { queued: 0, contracts: 0 }, "a re-run never queues twice");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  const ap = await approve(WF, store, approvalId(WF.id, "hire:hire-1"), "owner", NOW);
  assert.equal(ap.status, "done");
  const add = hits.find((h) => h.path.endsWith("/quick_add_employee"))!;
  assert.equal(add.body.employing_entity_id, ENT);
  assert.equal(add.body.email, "ari@example.com");
  assert.equal(add.body.work_location.name, "Sydney Office");

  assert.deepEqual(await hires(ctx), { queued: 0, contracts: 1 }, "the record id is read from the approval, then the contract is queued");
  assert.equal(writes().filter((h) => h.path.endsWith("/envelopes")).length, 0, "the envelope is not sent until approved");
  assert.equal((await store.get<Hire>("hires", "hire-1"))!.employee_id, EMP);

  await approve(WF, store, approvalId(WF.id, "contract:hire-1"), "owner", NOW);
  const env = hits.find((h) => h.path.endsWith("/envelopes") && h.method === "POST")!;
  assert.equal(env.body.status, "sent");
  assert.equal(env.body.templateId, TPL);
  assert.deepEqual(env.body.templateRoles, [{ email: "ari@example.com", name: "Ari Chen", roleName: "Employee" }]);
  await hires(ctx);
  assert.equal((await store.get<Hire>("hires", "hire-1"))!.status, "contract-sent");
});

test("hire: a bad email stops the record with a reason and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("hires", "hire-2", hire({ id: "hire-2", email: "not-an-email" }));
  assert.deepEqual(await hires(ctx), { queued: 0, contracts: 0 });
  const h = (await store.get<Hire>("hires", "hire-2"))!;
  assert.equal(h.status, "stopped");
  assert.match(h.reason ?? "", /email/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("pay rise: the employee is read, the salary version is queued, and the write runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  const c: Change = { id: "chg-1", employee_id: "emp-1", kind: "salary", status: "open", effective_date: "2026-12-01",
    award_id: "a1b2c3d4-e5f6-4890-abcd-ef1234567890", classification_id: "b1b2c3d4-e5f6-4890-abcd-ef1234567890", change_reason: "Annual review" };
  await store.put("changes", "chg-1", c);
  assert.deepEqual(await changes(ctx), { queued: 1 });
  assert.equal(writes().length, 0);
  assert.ok(hits.some((h) => h.method === "GET" && h.path.endsWith("/employees/emp-1")), "employee read first");
  await approve(WF, store, approvalId(WF.id, "change:chg-1"), "owner", NOW);
  const sv = hits.find((h) => h.path.endsWith("/salary_versions"))!;
  assert.equal(sv.body.effective_date, "2026-12-01");
  assert.equal(sv.body.change_reason, "Annual review");
  assert.deepEqual(await changes(ctx), { queued: 0 });
});

test("manager change: queues the employment details update with only the fields named", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("changes", "chg-2", { id: "chg-2", employee_id: "emp-1", kind: "employment", status: "open",
    primary_manager_id: "0139ebb7-6f3e-4bc0-954e-9e50614fccd1", team_ids: [] } satisfies Change);
  await changes(ctx);
  await approve(WF, store, approvalId(WF.id, "change:chg-2"), "owner", NOW);
  const pt = hits.find((h) => h.method === "PATCH")!;
  assert.deepEqual(pt.body, { primary_manager_id: "0139ebb7-6f3e-4bc0-954e-9e50614fccd1", team_ids: [] });
});

test("review cycle: the review periods are read, the new period is queued, and POST runs only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  const p: ReviewPlan = { id: "rp-1", name: "Annual review 2026", status: "open", template_ids: [TPL],
    employee_start_date: "2026-07-01", employee_end_date: "2026-07-31", employee_lock_out_date: "2026-08-15",
    reviewer_start_date: "2026-08-01", reviewer_end_date: "2026-08-10", reviewer_lock_out_date: "2026-08-20" };
  await store.put("review-plans", "rp-1", p);
  assert.deepEqual(await reviews(ctx), { queued: 1, existing: 1 });
  assert.equal(writes().length, 0, "no review opened by a cron");
  await approve(WF, store, approvalId(WF.id, "review:rp-1"), "owner", NOW);
  const body = hits.find((h) => h.method === "POST" && h.path.endsWith("/performance_reviews"))!.body;
  assert.equal(body.fixed_date, true);
  assert.deepEqual(body.reviewer_types, ["primary_manager"]);
  assert.equal(body.reviewer_lock_out_date, "2026-08-20");
});

test("the SDK write gate refuses an approved write when the deploy does not allow writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("hires", "hire-3", hire({ id: "hire-3" }));
  await hires(ctx);
  process.env.KIT_ALLOW_WRITES = "0";
  const ap = await approve(WF, store, approvalId(WF.id, "hire:hire-3"), "owner", NOW);
  assert.equal(ap.status, "failed");
  assert.equal(writes().length, 0, "no write reached the network");
});
