// Delivery tickets workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, record, gradeCheck, CRONS } from "../industries/agriculture-mining/workflows/finance-admin/tickets/index.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/finance-admin/tickets";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");

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
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/mailFolders\/[^/]+\/messages$/.test(p) && m === "GET") return json({ value: [
        { id: "AAMkDock1", subject: "Docket 88412", receivedDateTime: "2026-11-08T01:00:00Z" },
        { id: "AAMkDock2", subject: "Docket 88413", receivedDateTime: "2026-11-08T02:00:00Z" } ] });
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: "AAMkDraft1" });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const rowsTo = (table: string) => hits.filter((h) => h.method === "POST" && h.path.endsWith(`/workbook/tables/${table}/rows`));

const S: any = {
  business_name: "Test Grain",
  microsoft_365: { mailbox: "tickets@example.com", folder: "inbox", search: "docket",
    tickets: { drive: "DRIVE1", item: "ITEM1", table: "Tickets" }, qc: { drive: "DRIVE1", item: "ITEM1", table: "QC" }, qc_contact: "qc@example.com" },
  expected_grades: { "Log spec 1": "Grade 1", "Log spec 2": "Grade 2" },
};
const GOOD = { docket_no: "88412", date: "2026-11-08", carrier: "Haulage Co", supplier: "Farm A", site: "Yard 2", spec: "Log spec 1", grade: "Grade 1", net_tonnes: 24.5 };

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation or queue a register write", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
});

test("runtime: the SDK gate still blocks writes when the deploy does not allow them", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", input: { params: {}, body: { values: [[1]] } }, summary: "x" }), WriteBlocked);
  assert.equal(rowsTo("Tickets").length, 0);
});

test("intake refuses a mail folder that is a path segment, before any request is made", async () => {
  const store = new MemoryStore();
  for (const folder of ["..", "a.b", "inbox/../drafts"]) {
    const bad = { ...S, microsoft_365: { ...S.microsoft_365, folder } };
    await assert.rejects(intake(context(WF, bad, store, NOW, () => {})), /mail folder/);
  }
  assert.equal(hits.length, 0, "no folder value reaches Graph");
  const ids = { ...S, microsoft_365: { ...S.microsoft_365, folder: "AAMkADFolderId=" } };
  assert.deepEqual(await intake(context(WF, ids, store, NOW, () => {})), { added: 2 });
  assert.ok(decodeURIComponent(hits.find((h) => h.method === "GET")!.path).endsWith("/mailFolders/AAMkADFolderId=/messages"));
});

test("intake turns each docket email into one new ticket, never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  const list = hits.find((h) => h.method === "GET")!;
  assert.ok(list.path.endsWith("/mailFolders/inbox/messages"));
  assert.equal(sends().length, 0);
  const tickets = Object.values(await store.list<any>("tickets"));
  assert.equal(tickets.length, 2);
  assert.ok(tickets.every((t) => t.status === "new" && t.source === "mail"));
});

test("record writes a row for a complete ticket and holds an incomplete or unknown-spec one with a reason", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("tickets", "full", { key: "full", source: "shell", status: "new", ...GOOD });
  await store.put("tickets", "partial", { key: "partial", source: "shell", status: "new", docket_no: "88500" });
  await store.put("tickets", "badspec", { key: "badspec", source: "shell", status: "new", ...GOOD, docket_no: "88501", spec: "constructor" });
  assert.deepEqual(await record(ctx), { recorded: 1, held: 2 });
  const rows = rowsTo("Tickets");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].body.values, [["2026-11-08", "88412", "Haulage Co", "Farm A", "Yard 2", "Log spec 1", "Grade 1", 24.5, "Recorded"]]);
  assert.equal((await store.get<any>("tickets", "full")).status, "recorded");
  assert.match((await store.get<any>("tickets", "partial")).reason, /docket date/);
  assert.match((await store.get<any>("tickets", "badspec")).reason, /not in expected_grades/);
  assert.deepEqual(await record(ctx), { recorded: 0, held: 0 }, "a re-run never writes a row twice");
  assert.equal(rowsTo("Tickets").length, 1);
});

test("a wrong grade is flagged: QC row drafted, QC email queued, not sent; approval sends it once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("tickets", "bad", { key: "bad", source: "shell", status: "recorded", ...GOOD, docket_no: "88420", grade: "Grade 2" });
  await store.put("tickets", "ok", { key: "ok", source: "shell", status: "recorded", ...GOOD, docket_no: "88421" });
  assert.deepEqual(await gradeCheck(ctx), { flagged: 1, cleared: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(rowsTo("QC").length, 1);
  assert.equal(rowsTo("QC")[0].body.values[0][4], "Grade 2");
  const drafts = hits.filter((h) => h.method === "POST" && /\/users\/[^/]+\/messages$/.test(h.path));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body.toRecipients[0].emailAddress.address, "qc@example.com");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal((await store.get<any>("tickets", "bad")).status, "flagged");
  assert.equal((await store.get<any>("tickets", "ok")).status, "cleared");
  assert.deepEqual(await gradeCheck(ctx), { flagged: 0, cleared: 0 }, "a re-run never queues twice");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/messages\/AAMkDraft1\/send$/);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("the cron registry matches the entries in workflow.json", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
