// Subcontractor compliance workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, chase, records } from "../industries/construction/workflows/compliance-safety/x-subbies/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/compliance-safety/x-subbies/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let replies: any[] = [], rows: unknown[][] = [], dbxEntries: any[] = [], draftN = 0;

function fake() {
  hits = []; draftN = 0;
  replies = [{ id: "AAMkReply1", subject: "Public liability certificate attached", from: { emailAddress: { name: "Lou Park", address: "lou@example.com" } }, receivedDateTime: "2026-11-08T22:00:00Z" }];
  rows = [
    ["Ari Stone", "ari@example.com", "Electrical", "Public liability", "2026-11-20", "ok"],
    ["Sam Lee", "sam@example.com", "Plumbing", "Licence", "2027-06-01", "ok"],
    ["Jo Kim", "jo@example.com", "Concrete", "Workers compensation", "", "reply received"],
    ["Pat Brown", "pat@example.com", "Formwork", "White card", "2026-11-06", "ok"],
  ];
  dbxEntries = [
    { ".tag": "file", name: "Ari Stone PL.pdf", path_display: "/Jobs/12 Smith Street/Ari Stone PL.pdf", server_modified: "2026-11-05T01:00:00Z" },
    { ".tag": "folder", name: "Permits", path_display: "/Jobs/12 Smith Street/Permits" },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      // Dropbox
      if (p === "/2/files/list_folder") return json({ entries: dbxEntries, cursor: "c", has_more: false });
      // Microsoft Graph
      if (/\/mailFolders\/[^/]+\/messages$/.test(p)) return json({ value: replies });
      if (/\/messages$/.test(p) && m === "POST") return json({ id: `AAMkDraft${++draftN}` });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/rows") && m === "GET") return json({ value: rows.map((v) => ({ values: [v] })) });
      if (p.endsWith("/rows")) return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const SET: any = {
  business_name: "Test Trades Pty Ltd",
  microsoft_365: { mailbox: "office@example.com", folder: "inbox", search: "certificate", register: { drive: "DRIVE1", item: "ITEM1", table: "Subcontractors" } },
  dropbox: { job_folders: ["/Jobs/12 Smith Street"] },
  expiry_days: 30,
};
const NOW = new Date("2026-11-09T00:00:00Z");
const drafts = () => hits.filter((h) => /\/messages$/.test(h.path) && h.method === "POST");
const sends = () => hits.filter((h) => /\/send$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", DROPBOX_ACCESS_TOKEN: "dbx", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation and cannot queue a draft operation", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "dropbox", op: "files.delete_v2", summary: "x" }), /not a draft operation/);
  assert.equal(hits.length, 0);
});

test("intake: a reply becomes one register row to complete; re-runs add nothing; nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  const adds = hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].body.values[0], ["Lou Park", "lou@example.com", "", "Reply: Public liability certificate attached", "", "reply received"]);
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows")).length, 1, "second run adds no row");
  assert.equal(sends().length, 0);
});

test("chase: expiring and expired documents are drafted and queued, never sent; re-runs never draft or queue twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await chase(ctx), { queued: 2, skipped: 1 });
  assert.equal(drafts().length, 2, "one draft each for Ari and Pat");
  assert.deepEqual(drafts().map((h) => h.body.toRecipients[0].emailAddress.address), ["ari@example.com", "pat@example.com"]);
  assert.match(drafts()[1].body.body.content, /expired on 2026-11-06/);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
  assert.deepEqual(await chase(ctx), { queued: 0, skipped: 1 });
  assert.equal(drafts().length, 2, "re-run drafts nothing new");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2, "re-run queues nothing new");
});

test("approval sends the chase email once; a second approve is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await chase(ctx);
  const id = approvalId(WF.id, "chase:ari@example.com:public liability:2026-11-20");
  const ap = await approve(WF, store, id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "sent once, on approval");
  await assert.rejects(approve(WF, store, id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1);
});

test("an Excel date serial in the register is read as a date and chased", async () => {
  const serial = (Date.UTC(2026, 10, 25) - Date.UTC(1899, 11, 30)) / 864e5;
  rows = [["Ari Stone", "ari@example.com", "Electrical", "Public liability", serial, "ok"]];
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await chase(ctx), { queued: 1, skipped: 0 });
  assert.match(drafts()[0].body.body.content, /expires on 2026-11-25/);
});

test("records: one file list per job folder per day, drafted to the owner's own mailbox, never sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await records(ctx), { drafted: 1 });
  const list = hits.find((h) => h.path === "/2/files/list_folder")!;
  assert.equal(list.body.path, "/Jobs/12 Smith Street");
  assert.equal(list.body.recursive, false);
  const d = drafts()[0].body;
  assert.equal(d.toRecipients[0].emailAddress.address, "office@example.com");
  assert.match(d.body.content, /1 files in /);
  assert.match(d.body.content, /Ari Stone PL\.pdf/);
  assert.doesNotMatch(d.body.content, /Permits/, "folders are not listed as files");
  assert.equal(sends().length, 0);
  assert.deepEqual(await records(ctx), { drafted: 0 }, "same day: nothing new");
  assert.deepEqual(await records(context(WF, SET, store, new Date(NOW.getTime() + 864e5), () => {})), { drafted: 1 }, "next day: one more");
});

test("inputs from outside are checked before any call: a bad job folder or a bad mailbox never reaches the network", async () => {
  const badFolder = { ...SET, dropbox: { job_folders: ["Jobs/no-leading-slash"] } };
  await assert.rejects(records(context(WF, badFolder, new MemoryStore(), NOW, () => {})), /bad job folder/);
  const badBox = { ...SET, microsoft_365: { ...SET.microsoft_365, mailbox: "not-an-address" } };
  await assert.rejects(intake(context(WF, badBox, new MemoryStore(), NOW, () => {})), /mailbox/);
  assert.equal(hits.length, 0);
});

test("a job folder with a . or .. segment is refused before any Dropbox call", async () => {
  for (const folder of ["/Jobs/../Payroll", "/Jobs/./12 Smith Street", "/.."]) {
    await assert.rejects(records(context(WF, { ...SET, dropbox: { job_folders: [folder] } }, new MemoryStore(), NOW, () => {})), /bad job folder/, folder);
  }
  assert.equal(hits.filter((h) => h.path === "/2/files/list_folder").length, 0);
});
