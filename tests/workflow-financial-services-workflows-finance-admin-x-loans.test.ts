// Loans workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, CRONS } from "../industries/financial-services/workflows/finance-admin/x-loans/index.ts";
import fs from "node:fs";

const FOLDER = "industries/financial-services/workflows/finance-admin/x-loans";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const BOX = "enquiries@example.com.au", MSG = "AAMkReq1", DRAFT = "AAMkDraft1";
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = {
  business_name: "Test Finance",
  microsoft_365: { mailbox: BOX, folder: "inbox", search: "loan", register: { drive: "DRIVE1", item: "ITEM1", table: "LoanRegister" } },
  documents: ["Photo ID", "Last two payslips"],
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let inbox: any[] = [];
let rowsFail = false, rowsWritten = 0;

function fake() {
  hits = []; rowsFail = false; rowsWritten = 0;
  inbox = [{ id: MSG, subject: "Home loan enquiry", from: { emailAddress: { name: "Ari", address: "ari@example.com" } },
    receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Looking at a home loan" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/mailFolders/inbox/messages") && m === "GET") return json({ value: inbox });
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith(`/messages/${DRAFT}/send`)) return new Response(null, { status: 202 });
      if (p.endsWith("/rows") && m === "POST") {
        if (rowsFail) return new Response("register unavailable", { status: 500 });
        rowsWritten++;
        return json({ index: 0 });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons read and draft, and nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 1, skipped: 0 });
  assert.equal(sends().length, 0, "no cron sends");
  const row = hits.find((h) => h.path.endsWith("/rows"))!.body.values[0];
  assert.equal(row[3], "ari@example.com");
  assert.equal(row[5], "Documents requested");
});

test("the document request is queued, and sent only when approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].acts[0].op, "users.user.messages.message.send");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.ok(sends()[0].path.endsWith(`/${DRAFT}/send`));
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("re-runs never draft or queue the same enquiry twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  await intake(ctx); await draft(ctx);
  assert.equal(drafts().length, 1, "one Outlook draft");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "one approval");
});

test("a run that fails after the draft is made does not make a second draft or a second register row", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  rowsFail = true;
  await assert.rejects(draft(context(WF, SETTINGS, store, NOW, () => {})));
  rowsFail = false;
  assert.deepEqual(await draft(context(WF, SETTINGS, store, NOW, () => {})), { drafted: 1, skipped: 0 });
  assert.equal(drafts().length, 1, "one Outlook draft across both runs");
  assert.equal(rowsWritten, 1, "one register row across both runs");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "one approval");
});

test("the enquiry body preview is not stored: only the subject, name and email are kept", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  const [e] = Object.values(await store.list<any>("enquiries"));
  assert.equal("text" in e, false);
  assert.equal(JSON.stringify(e).includes("Looking at a home loan"), false, "the body preview text is not in the store");
});

test("a draft operation cannot send, and a live operation cannot be drafted", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x", input: { params: {} } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("an enquiry with no usable email address is skipped, not drafted", async () => {
  inbox = [{ id: "AAMkNoMail", subject: "loan", from: { emailAddress: { name: "X", address: "not-an-email" } }, receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "" }];
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, skipped: 1 });
  assert.equal(drafts().length, 0);
  assert.equal(sends().length, 0);
});

test("the cron table matches the workflow record", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
