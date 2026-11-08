// Due dates workflow tests. Every request goes to a fake network: no test reaches a real Xero organisation.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { scan, chase, CRONS } from "../industries/professional-services/workflows/finance-admin/x-duedates/index.ts";
import { xeroDay, intSetting } from "../industries/professional-services/workflows/finance-admin/x-duedates/adapters/xero.ts";
import type { Settings } from "../industries/professional-services/workflows/finance-admin/x-duedates/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/finance-admin/x-duedates/workflow.json", "utf8")) as WorkflowRecord;
const S: Settings = { business_name: "Test Accounting", chase_after_days: 7, deadline_window_days: 14 };
const NOW = new Date("2026-11-09T02:00:00Z");
const INV1 = "11111111-2222-4333-8444-555555555555", INV2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", INV3 = "99999999-8888-4777-8666-555555555555";
const PRJ1 = "12345678-1234-4234-8234-123456789012", PRJ2 = "87654321-4321-4321-8321-210987654321", PRJ3 = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const TASK1 = "deadbeef-dead-4bee-8fed-deadbeefdead";

type Hit = { method: string; path: string; headers: Record<string, string>; body: any };
let hits: Hit[] = [];
let failTask = 0;

function fake() {
  hits = []; failTask = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k.toLowerCase()] = v; });
      hits.push({ method: m, path: p, headers, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Xero accounting: invoices awaiting payment (page 1 only)
      if (p.endsWith("/Invoices") && m === "GET") {
        const page = Number(u.searchParams.get("page") ?? "1");
        if (page > 1) return json({ Invoices: [] });
        return json({ Invoices: [
          { InvoiceID: INV1, InvoiceNumber: "INV-001", Contact: { Name: "Acme Pty Ltd" }, DueDate: `/Date(${Date.parse("2026-10-25T00:00:00Z")}+0000)/`, AmountDue: 1200, Status: "AUTHORISED", Type: "ACCREC" },
          { InvoiceID: INV2, InvoiceNumber: "INV-002", Contact: { Name: "Blue Co" }, DueDate: "2026-11-20T00:00:00", AmountDue: 500, Status: "AUTHORISED", Type: "ACCREC" },
          { InvoiceID: INV3, InvoiceNumber: "INV-003", Contact: { Name: "Paid Co" }, DueDate: "2026-11-01", AmountDue: 0, Status: "AUTHORISED", Type: "ACCREC" },
        ] });
      }
      if (/\/Invoices\/[^/]+\/Email$/.test(p) && m === "POST") return new Response(null, { status: 204 });
      // Xero projects: open projects (one page), and task creation
      if (p.endsWith("/Projects") && m === "GET") {
        return json({ items: [
          { projectId: PRJ1, name: "Smith annual accounts", deadlineUtc: "2026-11-15T00:00:00Z", status: "INPROGRESS" },
          { projectId: PRJ2, name: "BAS Q1", deadlineUtc: "2027-03-01T00:00:00Z", status: "INPROGRESS" },
          { projectId: PRJ3, name: "No date yet", deadlineUtc: null, status: "INPROGRESS" },
        ], pagination: { page: 1, pageCount: 1 } });
      }
      if (/\/Projects\/[^/]+\/Tasks$/.test(p) && m === "POST") {
        if (failTask-- > 0) return new Response("{}", { status: 500 });
        return json({ taskId: TASK1 });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const posts = (re: RegExp) => hits.filter((h) => h.method === "POST" && re.test(h.path));
const emails = () => posts(/\/Invoices\/[^/]+\/Email$/);
const tasks = () => posts(/\/Projects\/[^/]+\/Tasks$/);

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("the crons match the workflow record, and a cron cannot run or queue an operation outside its list", async () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.emailInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "projects.createTask", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.deleteInvoice", summary: "x" }), /not a draft operation/);
});

test("Xero dates read as YYYY-MM-DD in both forms; junk reads as null; settings outside their range are refused", () => {
  assert.equal(xeroDay("/Date(1767225600000+0000)/"), "2026-01-01");
  assert.equal(xeroDay("2026-11-20T00:00:00"), "2026-11-20");
  assert.equal(xeroDay("2026-11-20"), "2026-11-20");
  assert.equal(xeroDay("soon"), null);
  assert.equal(xeroDay(undefined), null);
  assert.equal(intSetting(undefined, 1, 60, 14), 14);
  assert.throws(() => intSetting(0, 1, 60, 14), /whole number/);
  assert.throws(() => intSetting("7 days", 1, 90, 7), /whole number/);
});

test("scan: reads invoices and projects, drafts one internal task for the deadline in the window, never twice, never a send", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await scan(ctx), { invoices: 2, overdue: 1, projects: 3, tasks_drafted: 1 });
  assert.equal(tasks().length, 1, "only the project due inside 14 days gets a task");
  assert.equal(tasks()[0].path, `/projects.xro/2.0/Projects/${PRJ1}/Tasks`, "task posted to its own project");
  assert.deepEqual(tasks()[0].body, { name: "Due 2026-11-15: Smith annual accounts" });
  assert.ok(tasks()[0].headers["idempotency-key"], "task create carries an idempotency key");
  assert.equal(emails().length, 0, "nothing emailed by scan");
  assert.equal(Object.keys(await store.list("invoices")).length, 2, "invoices kept in the register");
  assert.deepEqual(await scan(context(WF, S, store, NOW, () => {})), { invoices: 2, overdue: 1, projects: 3, tasks_drafted: 0 });
  assert.equal(tasks().length, 1, "a re-run never makes a second task for the same deadline");
});

test("scan: with writes blocked on the deploy, the task is refused before any socket opens", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  await assert.rejects(scan(context(WF, S, new MemoryStore(), NOW, () => {})), WriteBlocked);
  assert.equal(tasks().length, 0);
  assert.equal(emails().length, 0);
});

test("chase: queues only invoices past the set days; a person's approval sends the one email; re-runs queue nothing new", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await chase(ctx), { overdue: 1, queued: 1 });
  assert.equal(emails().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => [a.platform, a.op]), [["xero", "accounting.emailInvoice"]]);
  assert.ok(ap.summary.includes("INV-001") && ap.summary.includes("Acme Pty Ltd"), "summary names the invoice and the contact");
  assert.deepEqual(await chase(context(WF, S, store, NOW, () => {})), { overdue: 1, queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "a re-run never queues the same chase twice");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(emails().length, 1);
  assert.equal(emails()[0].path, `/api.xro/2.0/Invoices/${INV1}/Email`);
  assert.equal(emails()[0].body, undefined, "Xero's invoice email takes no body");
});

test("chase: an overdue invoice is chased again at the next step, and a failed scan task is retried without a duplicate", async () => {
  const store = new MemoryStore();
  await chase(context(WF, S, store, NOW, () => {}));
  const later = new Date(NOW.getTime() + 7 * 864e5);   // 22 days overdue: step 3 of 7 days
  assert.deepEqual(await chase(context(WF, S, store, later, () => {})), { overdue: 1, queued: 1 });
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "one chase per step");
  failTask = 1;
  await assert.rejects(scan(context(WF, S, store, NOW, () => {})));
  assert.deepEqual(await scan(context(WF, S, store, NOW, () => {})), { invoices: 2, overdue: 1, projects: 3, tasks_drafted: 1 });
  assert.equal(tasks().length, 2, "the failed attempt and the retry; the retry is the only one that counted");
  assert.equal(Object.keys(await store.list("tasks")).length, 1);
});
