// Regulator-lodgements workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, register, reminders, dueOf } from "../industries/all/workflows/compliance-safety/regulator-lodgements/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/compliance-safety/regulator-lodgements";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MSG = "AAMkNotice1", DRAFT = "AAMkDraft1";
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: any = {
  family: "regulator-lodgement", business_name: "Test Builders Pty Ltd", owner_email: "owner@example.com.au",
  microsoft_365: { mailbox: "compliance@example.com.au", search: "regulator", register: { drive: "DRIVE1", item: "ITEM1", table: "Register" } },
  notice_rules: [{ match: "notice", due_days: 14 }], reminder_days: 7,
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let rows: string[][] = [];
let messages: any[] = [];
let failDrafts = false;

function fake() {
  hits = []; rows = []; failDrafts = false; messages = [{ id: MSG, subject: "Regulator notice: <script>x</script>", from: { emailAddress: { name: "Ari", address: "ari@regulator.gov.au" } }, receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "=HYPERLINK(1) Please lodge within 14 days" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/messages") && m === "POST") return failDrafts ? new Response("down", { status: 500 }) : json({ id: DRAFT });
      if (p.endsWith("/messages")) return json({ value: messages });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/rows") && m === "GET") return json({ value: rows.map((v) => ({ values: [v] })) });
      if (p.endsWith("/rows") && m === "POST") { rows.push(body.values[0]); return json({ index: rows.length - 1 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation or queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("intake reads the mailbox and stores each notice once, sending nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(hits.filter((h) => h.path.endsWith("/messages") && h.method === "GET").length, 2);
  assert.equal(sends().length, 0);
  assert.equal(Object.values(await store.list<any>("notices"))[0].status, "new");
});

test("register writes one row, drafts an escaped owner note, and queues its send once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await register(ctx), { logged: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const row = rows[0];
  assert.equal(row[2], "Regulator notice: <script>x</script>");
  assert.equal(row[4], "2026-11-22", "due date from the notice rule");
  assert.equal(row[5], "Open");
  assert.equal(row[3], "ari@regulator.gov.au");
  const html = drafts()[0].body.body.content;
  assert.ok(html.includes("&lt;script&gt;"), "subject text escaped in the note");
  assert.ok(!html.includes("<script>"));
  assert.equal(drafts()[0].body.toRecipients[0].emailAddress.address, "owner@example.com.au");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].acts[0].op, "users.user.messages.message.send");
  await intake(ctx); await register(ctx);
  assert.equal(rows.length, 1, "a notice is logged once");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
});

test("approval sends the owner note, and a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await register(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${DRAFT}/send$`));
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("reminders queue one owner reminder per open item inside the window, not for later or closed items", async () => {
  const store = new MemoryStore();
  rows = [
    ["2026-11-08", "k-soon", "Notice A", "a@x.gov.au", "2026-11-12", "Open"],
    ["2026-11-08", "k-later", "Notice B", "b@x.gov.au", "2026-12-30", "Open"],
    ["2026-11-08", "k-closed", "Notice C", "c@x.gov.au", "2026-11-10", "Lodged"],
    ["2026-11-08", "k-serial", "Notice D", "d@x.gov.au", "46000", "Open"],
    ["2026-11-08", "k-none", "Notice E", "e@x.gov.au", "", "Open"],
  ];
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await reminders(ctx), { queued: 2 });
  assert.equal(sends().length, 0);
  assert.equal(drafts().length, 2);
  assert.deepEqual(await reminders(ctx), { queued: 0 }, "same day: no second draft");
  assert.equal(drafts().length, 2);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2);
});

test("due cells: ISO dates and Excel serials are read, anything else is not a due date", () => {
  assert.equal(dueOf("2026-11-22"), "2026-11-22");
  assert.equal(dueOf("46000"), "2025-12-09");
  assert.equal(dueOf("22/11/2026"), "");
  assert.equal(dueOf(""), "");
});

test("a bad mailbox or a bad workbook id is refused before any call", async () => {
  const bad = { ...SETTINGS, microsoft_365: { ...SETTINGS.microsoft_365, register: { drive: "x/../y", item: "I", table: "T" } } };
  await assert.rejects(reminders(context(WF, bad, new MemoryStore(), NOW, () => {})), /bad workbook id/);
  const noOwner = { ...SETTINGS, owner_email: "not-an-email" };
  await assert.rejects(intake(context(WF, noOwner, new MemoryStore(), NOW, () => {})), /owner_email is not set/);
});

test("a notice whose owner note fails after its register row is written is retried without a second register row", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  failDrafts = true;
  await assert.rejects(register(ctx));
  failDrafts = false;
  assert.deepEqual(await register(ctx), { logged: 1 });
  assert.equal(rows.length, 1, "the notice is logged once, however many runs it took");
  assert.equal(rows[0][4], "2026-11-22", "the retry keeps the due date the row was written with");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
});

test("a notice rule matches the body preview, and the preview is not kept in the store", async () => {
  messages = [{ id: MSG, subject: "Regulator letter", from: { emailAddress: { address: "ari@regulator.gov.au" } }, receivedDateTime: "2026-11-08T00:00:00Z",
    bodyPreview: "Please lodge the return within 14 days" }];
  const store = new MemoryStore(), ctx = context(WF, { ...SETTINGS, notice_rules: [{ match: "lodge", due_days: 14 }] }, store, NOW, () => {});
  await intake(ctx);
  const [stored] = Object.values(await store.list<any>("notices"));
  assert.deepEqual(Object.keys(stored).sort(), ["due_days", "from", "id", "received", "ref", "status", "title"]);
  assert.ok(!("text" in stored), "no body preview in the stored notice");
  assert.equal(stored.due_days, 14);
  await register(ctx);
  assert.equal(rows[0][4], "2026-11-22", "the due date comes from the body match");
  assert.ok(!drafts()[0].body.body.content.includes("Please lodge"), "the owner note does not repeat the body");
});
