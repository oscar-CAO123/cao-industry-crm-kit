// Safety-forms workflow tests. Every request goes to a fake network: no test reaches a real SiteBook account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { describe } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { incidents, checklists, actions } from "../industries/all/workflows/compliance-safety/safety-forms/index.ts";
import { render, TARGETS } from "../tools/deploy.ts";

const DIR = "industries/all/workflows/compliance-safety/safety-forms";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const INC = "11111111-2222-4333-8444-555555555555", CHK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ACT = "99999999-8888-4777-8666-555555555555";
const TPL = "12345678-1234-4234-8234-123456789012";
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let emailFails = 0;

function fake() {
  hits = []; emailFails = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v2/incidents") return json([{ IncidentId: INC, IncidentNumber: "INC-0001", IncidentType: "Near miss" }, { IncidentId: "../etc", IncidentNumber: "bad" }]);
      if (p === "/v1/checklists") return json({ list: [
        { CheckListId: CHK, Title: "Pre-start", Template: false, CompletedOn: "2026-11-07T10:00:00Z" },
        { CheckListId: "not-a-guid", Template: false, CompletedOn: "2026-11-07T10:00:00Z" },
        { CheckListId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Title: "Template", Template: true, CompletedOn: "" },
        { CheckListId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Title: "Open", Template: false, CompletedOn: null }] });
      if (p === "/v2/actions") return json([{ ActionId: ACT, DueDate: "2026-11-01", ActionRequired: "Fix guard" }, { ActionId: "x/../y", DueDate: "2026-11-01" }]);
      if (p === `/v1/incidents/${INC}/report`) return json({ Message: "queued" });
      if (p === `/v1/checklists/${CHK}/report`) return json({ DocumentID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", FileName: "pre-start.pdf", RevisionDate: "2026-11-07" });
      if (p === `/v1/actions/${ACT}/email`) {
        if (emailFails-- > 0) return new Response("{}", { status: 500 });
        return json({ Message: "emailed" });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const reports = () => hits.filter((h) => h.path.endsWith("/report"));
const emails = () => hits.filter((h) => h.path.endsWith("/email"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SITEBOOK_API_KEY: "sb-test", KIT_ALLOW_WRITES: "1" });
});

test("every operation the workflow names exists in the SiteBook ops file", () => {
  for (const op of [...WF.draft_ops.sitebook, ...WF.live_ops.sitebook]) assert.doesNotThrow(() => describe("sitebook", op), op);
  assert.equal(WF.crons.length >= 2 && WF.crons.length <= 4, true);
  for (const c of WF.crons) assert.ok(c.entry in { incidents, checklists, actions }, `${c.entry} has a function`);
});

test("runtime: a cron cannot send, and cannot run a report generation as a live operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "sitebook", op: "docs.post_v1_actions_actionId_email", input: { params: { actionId: ACT } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "sitebook", op: "docs.post_v1_incidents_incidentId_report", input: { params: { incidentId: INC } }, summary: "x" }), /not a live operation/);
  assert.equal(emails().length, 0);
});

test("incidents and checklists: reports generated once each, bad ids skipped, nothing emailed", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await incidents(ctx), { open: 2, drafted: 1 });
  assert.deepEqual(await incidents(ctx), { open: 2, drafted: 0 }, "a second run generates nothing new");
  assert.deepEqual(await checklists(ctx), { completed: 2, drafted: 1 });
  assert.deepEqual(await checklists(ctx), { completed: 2, drafted: 0 });
  const made = reports().map((h) => h.path).sort();
  assert.deepEqual(made, [`/v1/checklists/${CHK}/report`, `/v1/incidents/${INC}/report`].sort());
  assert.ok(hits.filter((h) => h.path === "/v2/incidents").every((h) => h.search.includes("Open=true")), "incident read asks for open only");
  assert.equal(emails().length, 0, "crons never email");
  assert.equal(hits.some((h) => h.path.includes("..") || h.path.includes("not-a-guid")), false, "no bad id reaches a path");
});

test("actions: one chase per overdue action is queued, not sent; approval sends it once; a rerun queues nothing new", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await actions(ctx), { overdue: 2, queued: 1 });
  assert.equal(emails().length, 0, "queued, not sent");
  assert.deepEqual(await actions(ctx), { overdue: 2, queued: 1 });
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "re-runs never queue twice");
  assert.equal(pending[0].status, "pending");
  assert.match(pending[0].summary, /due 2026-11-01/);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(emails().length, 1, "sent once, on approval");
  assert.equal(emails()[0].path, `/v1/actions/${ACT}/email`);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("a failed chase email resumes on approval without a second queued approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await actions(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  emailFails = 1;
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "failed");
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(emails().length, 2, "the failed send and the retry, nothing more");
});

test("an email template chosen in settings is sent with the approval", async () => {
  const store = new MemoryStore();
  const s = { ...SETTINGS, sitebook: { ...SETTINGS.sitebook, email_template_id: TPL } };
  await actions(context(WF, s, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(emails()[0].body, { EmailTemplateId: TPL });
});

test("deploy: every target renders every cron", () => {
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, SETTINGS, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
  }
});
