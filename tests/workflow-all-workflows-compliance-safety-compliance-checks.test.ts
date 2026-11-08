// Compliance-checks workflow tests. Every request goes to a fake network: no test reaches a real First AML account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { caseWatch, openItems } from "../industries/all/workflows/compliance-safety/compliance-checks/index.ts";
import { readCase } from "../industries/all/workflows/compliance-safety/compliance-checks/adapters/first-aml.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/compliance-safety/compliance-checks/workflow.json", "utf8")) as WorkflowRecord;
const CASE = "CASE-1001";
const SETTINGS: any = { family: "aml-matter-onboarding", business_name: "Test Accounting", first_aml: { lookback_days: 30, max_pages: 3 } };
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; query: string };
let hits: Hit[] = [];
let noteStatus = 200;

function fake() {
  hits = []; noteStatus = 200;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
      const query: string = String(body?.query ?? "");
      hits.push({ method: m, path: p, query });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (!p.endsWith("/graphql")) return new Response("not faked: " + p, { status: 404 });
      if (query.includes("searchCases(")) return json({ data: { searchCases: { hasNextPage: false, nextCursor: null,
        cases: [{ caseId: CASE, caseStatus: "IN_PROGRESS", lastUpdatedOn: "2026-11-07T10:00:00Z" }] } } });
      if (query.includes("caseDetails(")) return json({ data: { caseDetails: { caseId: CASE, caseStatus: "IN_PROGRESS", lastUpdatedOn: "2026-11-07T10:00:00Z",
        individuals: [{ individualId: "IND-1", individualVerificationChecksStatus: { legalName: "PASS", dateOfBirth: "PASS", address: "PASS", governmentId: "PASS",
          pep: "NO_MATCH", sanctions: "POSSIBLE_MATCH", adverseMedia: "NO_MATCH", overall: "CONSIDER", dateVerified: null } }],
        entities: [{ entityId: "ENT-1", verificationCheckStatus: { overall: "IN_PROGRESS", sanctions: "NO_MATCH", warning: "NO_MATCH", fitnessProbity: "NOT_NEEDED", adverseMedia: "NO_MATCH", dateVerified: null } }] } } });
      if (query.includes("addCaseNote(")) return noteStatus === 200 ? json({ data: { addCaseNote: { caseId: CASE } } }) : json({}, noteStatus);
      return json({ errors: [{ message: "not faked" }] });
    }) as any,
  });
}
const mutations = () => hits.filter((h) => h.query.startsWith("mutation"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIRST_AML_ACCESS_TOKEN: "fa", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a write or queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "first-aml", op: "mutation.addCaseNote", input: { document: "x" }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "first-aml", op: "query.caseDetails", summary: "x" }), /not a live operation/);
});

test("case-watch reads only, records each person's check state, and moves the cursor", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await caseWatch(ctx), { read: 1 });
  assert.equal(mutations().length, 0, "nothing written by a cron");
  const rec = await store.get<any>("cases", CASE);
  assert.equal(rec.open_count, 1);
  const ind = rec.people.find((p: any) => p.id === "IND-1");
  assert.equal(ind.state, "open");
  assert.ok(ind.open.includes("sanctions"));
  assert.equal(rec.people.find((p: any) => p.id === "ENT-1").state, "waiting");
  assert.deepEqual(await store.get("cursor", "first-aml"), { updated_after: "2026-11-07T10:00:00Z" });
});

test("open-items queues one note for approval, and a re-run queues nothing new", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await caseWatch(ctx);
  assert.deepEqual(await openItems(ctx), { queued: 1 });
  assert.equal(mutations().length, 0, "the note is queued, never written");
  await caseWatch(ctx); await openItems(ctx);
  const pending = Object.values(await store.list<any>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "re-runs never queue twice");
  assert.match(pending[0].acts[0].input.document, /addCaseNote/);
  assert.ok(!pending[0].acts[0].input.document.includes("Test Accounting"), "no business or client names in the note");
});

test("an approved note runs once, and a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await caseWatch(ctx); await openItems(ctx);
  const id = Object.values(await store.list<any>("approvals"))[0].id;
  const ap = await approve(WF, store, id, "compliance-lead", NOW);
  assert.equal(ap.status, "done");
  assert.equal(mutations().length, 1);
  assert.match(mutations()[0].query, /addCaseNote\(input: \{caseId: "CASE-1001"/);
  await assert.rejects(approve(WF, store, id, "compliance-lead"), /already done/);
});

test("a write stays blocked when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await caseWatch(ctx); await openItems(ctx);
  const id = Object.values(await store.list<any>("approvals"))[0].id;
  const ap = await approve(WF, store, id, "compliance-lead", NOW);
  assert.equal(ap.status, "failed");
  assert.equal(mutations().length, 0);
});

test("a case ID that is not a plain identifier is refused before any call", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(readCase(ctx, '../x") { evil }'), /bad case id/);
  assert.equal(hits.length, 0);
});
