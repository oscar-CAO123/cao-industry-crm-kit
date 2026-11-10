// Automotive vehicle-listing workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, photos, draft, followUp, CRONS } from "../industries/automotive/workflows/sales/vehicle-listing/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/automotive/workflows/sales/vehicle-listing/workflow.json", "utf8")) as WorkflowRecord;
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let drafts = 0;

const STOCK_ROWS = [
  ["STK1", "2021", "Toyota", "RAV4 <img src=x>", "28990", "To list", "FOLDERA1"],
  ["STK2", "2019", "Mazda", "CX-5", "21500", "Sold", "FOLDERB2"],
  ["bad row", "2020", "X", "Y", "100", "To list", "FOLDERC3"],
];

function fake() {
  hits = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Excel: the stock register and the listing register
      if (m === "GET" && p.includes("/workbook/tables/Stock/rows")) return json({ value: STOCK_ROWS.map((r) => ({ values: [r] })) });
      if (m === "POST" && p.endsWith("/workbook/tables/Listings/rows")) return json({ index: 0 });
      // OneDrive: photo folders (STK1 has 7 images and a PDF; STK2 has 2 images)
      if (m === "GET" && p.endsWith("/children") && p.includes("FOLDERA1")) return json({ value: [
        ...Array.from({ length: 7 }, (_, i) => ({ name: `${i}.jpg`, file: { mimeType: "image/jpeg" } })), { name: "notes.pdf", file: { mimeType: "application/pdf" } }] });
      if (m === "GET" && p.endsWith("/children") && p.includes("FOLDERB2")) return json({ value: [{ name: "a.jpg", file: { mimeType: "image/jpeg" } }, { name: "b.jpg", file: { mimeType: "image/png" } }] });
      // Outlook: drafts and sends
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const registerRows = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/Listings/rows"));

const SETTINGS: any = {
  business_name: "Test Motors",
  microsoft_365: { mailbox: "sales@example.com.au", stock: { drive: "D1", item: "I1", table: "Stock" },
    register: { drive: "D1", item: "I2", table: "Listings" }, photos: { drive: "D1" } },
  listing_to: "listings@example.com.au",
  transfer_to: "transfers@example.com.au",
  min_photos: 6,
};
const DESCRIPTION = "2021 Toyota RAV4, one owner.\n\nService history on file. Ready for a test drive.";
const NOW = new Date("2026-11-09T00:00:00Z");
const TWO_DAYS = new Date("2026-11-11T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the crons are keyed by their entry names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["draft", "follow-up", "intake", "photos"]);
  assert.equal(WF.id, "automotive:vehicle-listing");
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
});

test("intake takes only rows marked To list with a valid stock id, folder and price", async () => {
  const store = new MemoryStore();
  const r = await intake(context(WF, SETTINGS, store, NOW, () => {})) as any;
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 2, "a sold row and a row with a bad stock id are skipped");
  const v = Object.values(await store.list<any>("vehicles"));
  assert.equal(v.length, 1);
  assert.equal(v[0].stock, "STK1");
  assert.equal(v[0].price, 28990);
});

test("photos marks a vehicle ready at the minimum, and nothing is sent", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await photos(context(WF, SETTINGS, store, NOW, () => {}));
  const v = Object.values(await store.list<any>("vehicles"))[0];
  assert.equal(v.status, "ready");
  assert.equal(v.photos, 7, "the PDF is not counted");
  assert.equal(sends().length, 0);
});

test("a ready vehicle without listing copy is parked, not drafted", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await photos(context(WF, SETTINGS, store, NOW, () => {}));
  await draft(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(drafts, 0);
  const v = Object.values(await store.list<any>("vehicles"))[0];
  assert.equal(v.status, "ready");
  assert.match(v.reason, /no listing copy/);
});

test("crons never send; listing copy is one Outlook draft, one register row and one queued send", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx()); await photos(ctx());
  await store.put("proposals", Object.values(await store.list<any>("vehicles"))[0].id, { description: DESCRIPTION });
  await draft(ctx());
  assert.equal(sends().length, 0, "no send reached the network");
  assert.equal(drafts, 1);
  assert.equal(registerRows().length, 1);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.equal(aps[0].acts[0].input?.params?.["user-id"], "sales@example.com.au");
});

test("the listing draft escapes the vehicle title", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx()); await photos(ctx());
  const id = Object.values(await store.list<any>("vehicles"))[0].id;
  await store.put("proposals", id, { description: DESCRIPTION });
  await draft(ctx());
  const created = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
  assert.equal(created.length, 1);
  const html = String(created[0].body.body.content);
  assert.ok(!html.includes("<img"), "raw tag must not reach the email body");
  assert.ok(html.includes("&lt;img"));
});

test("approval runs the send, then follow-up marks the vehicle listed", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx()); await photos(ctx());
  const id = Object.values(await store.list<any>("vehicles"))[0].id;
  await store.put("proposals", id, { description: DESCRIPTION });
  await draft(ctx());
  const v = await store.get<any>("vehicles", id);
  const done = await approve(WF, store, v.approval, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  await followUp(ctx());
  assert.equal((await store.get<any>("vehicles", id)).status, "listed");
});

test("a re-run never drafts or queues the same listing twice", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx()); await photos(ctx());
  const id = Object.values(await store.list<any>("vehicles"))[0].id;
  await store.put("proposals", id, { description: DESCRIPTION });
  await draft(ctx());
  await intake(ctx()); await photos(ctx()); await draft(ctx());
  assert.equal(drafts, 1, "one Outlook draft, no more");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("a sold vehicle gets one transfer checklist queued, never sent, with no buyer details", async () => {
  const store = new MemoryStore();
  const ctx = (now = NOW) => context(WF, SETTINGS, store, now, () => {});
  await intake(ctx()); await photos(ctx());
  const id = Object.values(await store.list<any>("vehicles"))[0].id;
  await store.put("proposals", id, { description: DESCRIPTION });
  await draft(ctx());
  await approve(WF, store, (await store.get<any>("vehicles", id)).approval, "owner", NOW);
  await followUp(ctx());
  assert.equal((await store.get<any>("vehicles", id)).status, "listed");

  await store.put("proposals", id, { description: DESCRIPTION, sold: true });
  await followUp(ctx(TWO_DAYS));
  assert.equal((await store.get<any>("vehicles", id)).status, "transfer-drafted");
  assert.equal(sends().length, 1, "only the listing copy has been sent; the checklist is queued");
  const transferDraft = hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages")).at(-1)!;
  assert.equal(transferDraft.body.toRecipients[0].emailAddress.address, "transfers@example.com.au");
  assert.ok(!String(transferDraft.body.body.content).toLowerCase().includes("buyer name"), "no buyer details in the checklist");

  await followUp(ctx(TWO_DAYS));
  assert.equal(drafts, 2, "a second follow-up does not draft the checklist again");
  assert.equal(Object.keys(await store.list("approvals")).length, 2);
});
