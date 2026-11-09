// Bills of materials workflow tests. Every request goes to a fake Unleashed: no test reaches a real account.
// The fake answers the mapped reads and writes, and every request is checked for the three sign-in headers and an
// HMAC-SHA256 signature over its own query string.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { check, draft, revise } from "../industries/manufacturing/workflows/fulfilment/x-bom/index.ts";
import { billBody } from "../industries/manufacturing/workflows/fulfilment/x-bom/adapters/unleashed.ts";
import { keyOf, linesHash, type BomRecord, type Settings } from "../industries/manufacturing/workflows/fulfilment/x-bom/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/manufacturing/workflows/fulfilment/x-bom/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const PARENT = "11111111-2222-4333-8444-555555555555", SIDE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SHELF = "99999999-8888-4777-8666-555555555555", BILL = "12345678-1234-4234-8234-123456789012";
const DESK = "22222222-3333-4444-8555-666666666666", DESK_BILL = "87654321-4321-4321-8321-210987654321";
const KEYS = { UNLEASHED_API_ID: "test-api-id", UNLEASHED_API_KEY: "test-api-key", UNLEASHED_CLIENT_TYPE: "test-client-type" };

/** The products the fake Unleashed holds, by code. */
const CATALOG: Record<string, string> = { BOOKSHELF: PARENT, DESK, SIDE, SHELF };
let stock: Record<string, number> = {};
/** Live bills in the fake, by product Guid. */
let bills: Record<string, any> = {};

type Hit = { method: string; path: string; query: string; body: any; headers: Record<string, string> };
let hits: Hit[] = [];

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
function answer(method: string, u: URL): Response {
  if (method === "GET" && u.pathname === "/Products") {
    const code = u.searchParams.get("productCode") ?? "";
    return json({ Items: CATALOG[code] ? [{ Guid: CATALOG[code], ProductCode: code }] : [], Pagination: { NumberOfPages: 1 } });
  }
  if (method === "GET" && u.pathname === "/BillOfMaterials") {
    const b = bills[u.searchParams.get("productGuid") ?? ""];
    return json({ Items: b ? [b] : [] });
  }
  if (method === "GET" && u.pathname.startsWith("/StockOnHand/")) return json([{ AvailableQty: stock[u.pathname.split("/")[2]] ?? 0 }]);
  if (method === "POST" && u.pathname === "/BillOfMaterials") return json({ Guid: DESK_BILL });
  if (method === "PUT" && u.pathname === `/BillOfMaterials/${BILL}`) return json({ Guid: BILL });
  return json({ Message: "not in the fake" }, 404);
}
function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      hits.push({ method, path: u.pathname, query: u.search.replace(/^\?/, ""), body: init?.body ? JSON.parse(init.body) : undefined, headers: { ...init?.headers } });
      return answer(method, u);
    }) as any,
  });
}
/** Every request carries the three sign-in headers, and its signature is the HMAC of its own query string. */
function assertSigned(h: Hit) {
  assert.equal(h.headers["api-auth-id"], KEYS.UNLEASHED_API_ID);
  assert.equal(h.headers["client-type"], KEYS.UNLEASHED_CLIENT_TYPE);
  const want = crypto.createHmac("sha256", KEYS.UNLEASHED_API_KEY).update(h.query, "utf8").digest("base64");
  assert.equal(h.headers["api-auth-signature"], want, `${h.method} ${h.path} is signed over its query string`);
}

const settingsWith = (shelfQty: number, extra: { code: string; qty: number }[] = []): Settings => ({
  business_name: "Test Manufacturing",
  boms: [{ parent: "BOOKSHELF", lines: [{ code: "SIDE", qty: 2 }, { code: "SHELF", qty: shelfQty }, ...extra] }],
});
/** The bill the workflow recorded when it created it: two components. */
function seedRecord(store: MemoryStore) {
  const before = [{ code: "SIDE", qty: 2 }, { code: "SHELF", qty: 4 }];
  const rec: BomRecord = { parent: "BOOKSHELF", parent_guid: PARENT, guid: BILL, hash: linesHash(before), created: NOW.toISOString(),
    lines: [{ code: "SIDE", qty: 2, guid: SIDE }, { code: "SHELF", qty: 4, guid: SHELF }] };
  return store.put("boms", keyOf("BOOKSHELF"), rec);
}
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  bills = {}; stock = { [SIDE]: 10, [SHELF]: 10 };
  Object.assign(process.env, { KIT_ALLOW_WRITES: "1", ...KEYS });
});

test("check reads the live bill, draft creates the missing one, and every request is signed", async () => {
  const store = new MemoryStore();
  const settings: Settings = { boms: [
    { parent: "BOOKSHELF", lines: [{ code: "SIDE", qty: 2 }, { code: "SHELF", qty: 4 }] },
    { parent: "DESK", lines: [{ code: "SIDE", qty: 1 }] },
  ] };
  await seedRecord(store);
  bills[PARENT] = { Guid: BILL, Product: { Guid: PARENT }, Obsolete: false,
    BillOfMaterialsLines: [{ Product: { Guid: SIDE }, Quantity: 2 }, { Product: { Guid: SHELF }, Quantity: 4 }] };
  stock[SHELF] = 3;
  const ctx = context(WF, settings, store, NOW, () => {});
  assert.deepEqual(await check(ctx), { synced: 1, short: 1 });
  assert.deepEqual(await draft(ctx), { created: 1, parked: 0 });
  const post = hits.find((h) => h.method === "POST");
  assert.ok(post, "draft created the bill for DESK");
  assert.deepEqual(post.body, billBody(DESK, [{ guid: SIDE, qty: 1 }]));
  assert.ok(hits.length > 0);
  hits.forEach(assertSigned);
  assert.ok(Object.values(await store.list<any>("problems")).some((p) => p.kind === "short-SHELF"));
  assert.equal((await store.get<BomRecord>("boms", keyOf("DESK")))?.guid, DESK_BILL);
});

test("a change to a live bill is queued, never sent, and a re-run does not queue it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, settingsWith(6), store, NOW, () => {});
  await seedRecord(store);
  assert.deepEqual(await revise(ctx), { queued: 1, parked: 0 });
  assert.equal(hits.length, 0, "nothing sent by a cron");
  const [ap] = await approvals(store);
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["docs.put_BillOfMaterials_billOfMaterialsGuid"]);
  assert.deepEqual(ap.acts[0].input?.params, { billOfMaterialsGuid: BILL });
  assert.deepEqual(ap.acts[0].input?.body, billBody(PARENT, [{ guid: SIDE, qty: 2 }, { guid: SHELF, qty: 6 }], BILL));
  assert.equal(ap.acts[0].input?.body.Guid, BILL, "an update carries the bill's own Guid");
  await revise(ctx);
  assert.equal((await approvals(store)).length, 1, "re-runs never queue the same change twice");
});

test("an approved change is sent only on approval, to the bill's own URL, signed, and never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, settingsWith(6), store, NOW, () => {});
  await seedRecord(store);
  await revise(ctx);
  assert.equal(hits.length, 0, "nothing sent before approval");
  const [ap] = await approvals(store);
  const res = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(res.status, "done");
  assert.equal(hits.length, 1);
  const put = hits[0];
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/BillOfMaterials/${BILL}`);
  assert.equal(put.body.Guid, BILL);
  assert.deepEqual(put.body.Product, { Guid: PARENT });
  assertSigned(put);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(hits.length, 1, "a second approval sends nothing");
});

test("a change approved earlier is queued again when the live bill has since moved off those lines", async () => {
  const store = new MemoryStore(), ctx = context(WF, settingsWith(6), store, NOW, () => {});
  await seedRecord(store);
  await revise(ctx);
  const [first] = await approvals(store);
  assert.equal((await approve(WF, store, first.id, "owner", NOW)).status, "done");
  // The bill is put back to four shelves in Unleashed and the record is brought in step with it, as the hourly check does.
  await seedRecord(store);
  await revise(ctx);
  const aps = await approvals(store);
  assert.equal(aps.length, 2, "the change to six shelves is queued again, not silently dropped");
  assert.equal(aps.filter((a) => a.status === "pending").length, 1);
  await revise(ctx);
  assert.equal((await approvals(store)).length, 2, "a re-run does not queue the pending change a third time");
});

test("a component that is not on the live bill is parked, never queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, settingsWith(4, [{ code: "BRACKET", qty: 2 }]), store, NOW, () => {});
  await seedRecord(store);
  assert.deepEqual(await revise(ctx), { queued: 0, parked: 1 });
  assert.equal((await approvals(store)).length, 0);
  const problems = Object.values(await store.list<any>("problems"));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "new-component");
});

test("a bad product code is refused before anything is built or queued", async () => {
  const store = new MemoryStore();
  await seedRecord(store);
  const bad: Settings = { boms: [{ parent: "BOOKSHELF", lines: [{ code: "SIDE;DROP", qty: 2 }] }] };
  assert.deepEqual(await revise(context(WF, bad, store, NOW, () => {})), { queued: 0, parked: 1 });
  assert.equal((await approvals(store)).length, 0);
  const problems = Object.values(await store.list<any>("problems"));
  assert.equal(problems[0].kind, "refused");
  assert.doesNotMatch(problems[0].detail, /DROP/, "the refusal does not echo the value");
  assert.equal(hits.length, 0);
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, settingsWith(4), new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.put_BillOfMaterials_billOfMaterialsGuid", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "unleashed", op: "docs.post_BillOfMaterials", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bill bodies: components numbered from 1, product by Guid; only an update carries the bill's own Guid", () => {
  const made = billBody(PARENT, [{ guid: SIDE, qty: 2 }, { guid: SHELF, qty: 6 }]);
  assert.equal(made.Product.Guid, PARENT);
  assert.deepEqual(made.BillOfMaterialsLines.map((l) => l.LineNumber), [1, 2]);
  assert.deepEqual(made.BillOfMaterialsLines.map((l) => l.Quantity), [2, 6]);
  assert.equal("Guid" in made, false, "a new bill has no Guid of its own");
  const changed = billBody(PARENT, [{ guid: SIDE, qty: 2 }], BILL);
  assert.equal(changed.Guid, BILL);
  assert.equal(changed.Product.Guid, PARENT);
});
