// PPSR workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, digest } from "../industries/automotive/workflows/compliance-safety/ppsr/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/automotive/workflows/compliance-safety/ppsr/workflow.json", "utf8")) as WorkflowRecord;
const VIN1 = "WVWZZZ1JZXW000001", VIN2 = "JTEHH20V900012345";
const MSG = "AAMkDigest1";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let checkRows: any[][] = [];

const STOCK: any[][] = [
  [VIN1.toLowerCase(), "abc123", "S100", "2026-11-01"],   // valid, lower case: normalised
  [VIN1, "ABC123", "S100", "2026-11-01"],                 // duplicate of the first: skipped
  ["NOT-A-VIN", "XYZ999", "S101", "2026-11-02"],          // bad VIN: skipped
  [VIN2, "", "S102", "2026-11-03"],                       // no rego yet: kept
];

/** The rows one ListRows page returns: $top rows from $skip, as the Graph API does. */
const page = (rows: any[][], u: URL) => {
  const top = Number(u.searchParams.get("$top") ?? rows.length), skip = Number(u.searchParams.get("$skip") ?? 0);
  return rows.slice(skip, skip + top).map((values) => ({ values: [values] }));
};
const vinAt = (i: number) => "WVWZZZ1JZXW" + String(i).padStart(6, "0");

function fake(stock: any[][] = STOCK) {
  hits = []; checkRows = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.includes("/tables/STOCK/rows") && m === "GET") return json({ value: page(stock, u) });
      if (p.includes("/tables/CHK/rows") && m === "GET") return json({ value: page(checkRows, u) });
      if (p.includes("/tables/CHK/rows") && m === "POST") { checkRows.push(...body.values); return json({ index: checkRows.length - 1 }); }
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: MSG });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => /\/users\/[^/]+\/messages$/.test(h.path) && h.method === "POST");
const SETTINGS: any = {
  business_name: "Test Motors",
  microsoft_365: { mailbox: "compliance@example.com.au", stock: { drive: "DRV", item: "ITM", table: "STOCK" }, checks: { drive: "DRV", item: "ITM", table: "CHK" } },
  compliance_contact: "compliance@example.com.au",
};
const NOW = new Date("2026-11-09T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: the digest cannot send from a cron, and a cron cannot queue a register write", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", input: { params: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.CreateRows", summary: "x" }), /not a live operation/);
});

test("register: adds each valid stock vehicle once, normalises it, and a re-run adds nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await register(ctx), { added: 2 });
  assert.equal(checkRows.length, 2);
  assert.equal(checkRows[0][1], VIN1, "lower case VIN stored in upper case");
  assert.equal(checkRows[0][4], "To search");
  assert.equal(checkRows[1][1], VIN2);
  assert.equal(checkRows[1][2], "", "blank rego kept blank");
  assert.deepEqual(await register(ctx), { added: 0 }, "re-run adds nothing");
  assert.equal(checkRows.length, 2);
  assert.equal(sends().length, 0, "register never sends");
});

test("digest: one draft and one queued approval per day; approval sends the draft; a re-run never repeats it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await register(ctx);
  assert.deepEqual(await digest(ctx), { queued: 1, to_search: 2, discharge_due: 0 });
  assert.equal(drafts().length, 1);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "users.user.messages.message.send");
  assert.deepEqual(await digest(ctx), { queued: 0, reason: "already drafted today" });
  assert.equal(drafts().length, 1, "no second draft on the same day");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "no second approval");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, new RegExp(`/messages/${MSG}/send$`));
});

test("digest: a day with nothing to report drafts nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  checkRows = [["2026-11-01", VIN1, "ABC123", "S100", "Clear", "2026-11-01", "REF1", ""]];
  assert.deepEqual(await digest(ctx), { queued: 0, reason: "nothing to report" });
  assert.equal(drafts().length, 0);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("digest: a discharge due is reported with the searches to run", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  checkRows = [["2026-10-20", VIN2, "", "S102", "Discharge due", "2026-10-20", "REF2", ""]];
  assert.deepEqual(await digest(ctx), { queued: 1, to_search: 0, discharge_due: 1 });
  const html = drafts()[0].body.body.content as string;
  assert.match(html, /Discharge due \(1\)/);
  assert.match(html, new RegExp(VIN2));
});

test("register: a register and stock list past 1,000 rows are read to the end, so no vehicle is missed or added twice", async () => {
  const stock = Array.from({ length: 1500 }, (_, i) => [vinAt(i), "", `S${i}`, "2026-11-01"]);
  fake(stock);
  checkRows = stock.slice(0, 1200).map((r) => ["2026-11-09", r[0], "", r[2], "To search", "", "", "from stock list"]);
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await register(ctx), { added: 300 }, "only the 300 vehicles past row 1,200 are new");
  assert.equal(checkRows.length, 1500);
  assert.equal(new Set(checkRows.map((r) => r[1])).size, 1500, "every vehicle is on the register exactly once");
  assert.equal(checkRows[1499][1], vinAt(1499));
});

test("register: a table past the page cap stops the run with an error and writes nothing", async () => {
  fake(Array.from({ length: 50000 }, () => ["", "", "", ""]));
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(register(ctx), /has more than 50000 rows/);
  assert.equal(checkRows.length, 0);
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "no partial write");
});
