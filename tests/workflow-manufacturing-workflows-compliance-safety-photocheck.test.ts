// Photocheck workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, register, report, CRONS } from "../industries/manufacturing/workflows/compliance-safety/photocheck/index.ts";

const DIR = "industries/manufacturing/workflows/compliance-safety/photocheck";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T01:00:00Z");
const S: any = { business_name: "Test Engineering", microsoft_365: { mailbox: "checks@example.com", folder: "inbox", search: "photo",
  register: { drive: "DRIVE_ID", item: "WORKBOOK_ITEM_ID", table: "Checks" } } };
const MSG = "AAMkReq1", DRAFT = "AAMkDraft1";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let rows = 0;

function fake() {
  hits = []; rows = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: DRAFT });
      if (p.endsWith("/messages")) return json({ value: [{ id: MSG, subject: "Photos of finished brackets", from: { emailAddress: { name: "Ari", address: "ari@example.com" } },
        receivedDateTime: "2026-11-08T00:00:00Z", bodyPreview: "Batch 42 photos attached" }] });
      if (p.endsWith("/rows") && m === "POST") { rows++; return json({ index: rows - 1 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("runtime: the SDK gate still blocks a register write when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x",
    input: { params: { "drive-id": "DRIVE_ID", "driveItem-id": "WORKBOOK_ITEM_ID", "workbookTable-id": "Checks" }, body: { values: [["x"]] } } }), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("crons are keyed by their entry names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["intake", "register", "report"]);
});

test("a request is logged once, its result email is drafted and queued, and only an approval sends it", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx()), { added: 1 });
  assert.deepEqual(await register(ctx()), { logged: 1 });
  assert.equal(rows, 1);
  assert.equal(sends().length, 0, "nothing sent by a cron");

  // A person records the result on the check (the write the CRM shell will do).
  const [key] = Object.keys(await store.list("checks"));
  const c = await store.get<any>("checks", key);
  await store.put("checks", key, { ...c, status: "result-ready", result: { decision: "fail", note: "Hole <3> is 0.4 mm off drawing." } });

  assert.deepEqual(await report(ctx()), { queued: 1 });
  assert.equal(sends().length, 0, "a cron that drafts never sends");
  assert.equal(drafts().length, 1);
  const d = drafts()[0].body;
  assert.equal(d.toRecipients[0].emailAddress.address, "ari@example.com");
  assert.match(d.body.content, /does not meet the spec/);
  assert.match(d.body.content, /Hole &lt;3&gt; is 0.4 mm off drawing\./, "customer text is escaped");

  // Re-runs never draft, register or queue a second time.
  await report(ctx()); await register(ctx()); await intake(ctx());
  assert.equal(drafts().length, 1);
  assert.equal(rows, 1);
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");

  const ap = await approve(WF, store, approvals[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${DRAFT}/send$`));
  await assert.rejects(approve(WF, store, approvals[0].id, "owner"), /already done/);
});
