// Takeoff workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, CRONS } from "../industries/manufacturing/workflows/sales/takeoff/index.ts";

const DIR = "industries/manufacturing/workflows/sales/takeoff";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const OPS = JSON.parse(fs.readFileSync("core/sdk/platforms/microsoft-365/ops.json", "utf8")) as { id: string }[];
const REQ = "AAMkReq1", DRAFT = "AAMkDraft1";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let takeoff: (string | number)[][] = [], rate: (string | number)[][] = [];

function fake() {
  hits = [];
  takeoff = [["JB2041", "PLATE-6", 4, "sheet"], ["JB2041", "HINGE", 12, "each"]];
  rate = [["PLATE-6", "6mm plate", "sheet", 180], ["HINGE", "Hinge", "each", 14.5]];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith("/messages")) return json({ value: [{ id: REQ, subject: "Takeoff request JB 2041, hinges and plate", from: { emailAddress: { name: "Ari <b>Lee", address: "ari@example.com" } },
        receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Please quote from the drawings" }] });
      if (p.endsWith("/rows") && m === "GET") {
        const rows = p.includes("/tables/Takeoff/") ? takeoff : rate;
        return json({ value: rows.map((r, i) => ({ index: i, values: [r] })) });
      }
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const SET: any = { family: "takeoff-from-drawings", business_name: "Test Fabrication", intake: ["microsoft-365"], takeoff: "microsoft-365", rate_card: "microsoft-365", quotes: "microsoft-365",
  microsoft_365: { mailbox: "estimating@example.com", folder: "inbox", search: "takeoff",
    takeoff: { drive: "D1", item: "I1", table: "Takeoff" }, rate_card: { drive: "D1", item: "I1", table: "SupplierPrices" }, register: { drive: "D1", item: "I1", table: "Takeoffs" } } };
const NOW = new Date("2026-11-08T00:00:00Z");
const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const drafts = () => hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("the workflow record matches the code and the kit's operation lists", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.entry} is in CRONS`);
  const ids = new Set(OPS.map((o) => o.id));
  for (const list of [...Object.values(WF.draft_ops), ...Object.values(WF.live_ops)]) for (const id of list) assert.ok(ids.has(id), `${id} is in ops.json`);
  assert.ok(!WF.draft_ops["microsoft-365"].some((o) => /send|delete/i.test(o)), "no send or delete is a draft operation");
  assert.deepEqual(WF.live_ops["microsoft-365"], ["users.user.messages.message.send"]);
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("takeoff request: register row and Outlook draft are made, the send is queued, and no cron sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 1, parked: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const reg = hits.find((h) => h.path.endsWith("/tables/Takeoffs/rows") && h.method === "POST")!.body.values[0];
  assert.equal(reg[1], "JB2041");
  assert.equal(reg[5], 4 * 180 + 12 * 14.5, "register total is the priced takeoff");
  const d = drafts()[0].body;
  assert.equal(d.toRecipients[0].emailAddress.address, "ari@example.com");
  assert.ok(d.body.content.includes("6mm plate"));
  assert.ok(d.body.content.includes("Ari &lt;b&gt;Lee"), "requester name is escaped in the email");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.match(ap.summary, /2 lines, \$894\.00 ex GST/);
});

test("re-runs never queue or draft twice, even if a request status is reset", async () => {
  const store = new MemoryStore(), c = () => context(WF, SET, store, NOW, () => {});
  await intake(c()); await draft(c());
  await intake(c()); await draft(c());
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "one approval");
  assert.equal(drafts().length, 1, "one Outlook draft");
  const enq = Object.values(await store.list<any>("enquiries"))[0];
  await store.put("enquiries", enq.id, { ...enq, status: "new" });
  await draft(c());
  assert.equal(drafts().length, 1, "a quote already drafted is never drafted again");
});

test("approval sends the draft once; a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${DRAFT}/send$`));
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "still sent once");
});

test("a request with no takeoff rows yet is parked, then drafted once the estimator enters them", async () => {
  const store = new MemoryStore(), c = () => context(WF, SET, store, NOW, () => {});
  takeoff = [];
  await intake(c());
  assert.deepEqual(await draft(c()), { drafted: 0, parked: 1 });
  assert.equal(drafts().length, 0);
  takeoff = [["JB2041", "HINGE", 12, "each"]];
  assert.deepEqual(await draft(c()), { drafted: 1, parked: 0 });
});

test("a takeoff code that is not on the rate card parks the request for pricing and drafts nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  takeoff = [["JB2041", "NOPE-9", 2, "each"]];
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, parked: 1 });
  assert.equal(drafts().length, 0);
  assert.equal(hits.filter((h) => h.path.endsWith("/tables/Takeoffs/rows")).length, 0, "no register row");
  const [e] = Object.values(await store.list<any>("enquiries"));
  assert.equal(e.status, "needs-pricing");
  assert.match(e.reason, /NOPE-9/);
});
