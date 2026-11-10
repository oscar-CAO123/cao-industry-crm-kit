// Product data pipeline tests. Every request goes to a fake network: no test reaches Unleashed or WooCommerce.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { check, stock, retire, CRONS } from "../industries/retail/workflows/fulfilment/products/index.ts";
import type { Flag, Settings } from "../industries/retail/workflows/fulfilment/products/types.ts";

const DIR = "industries/retail/workflows/fulfilment/products";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const G1 = "11111111-2222-4333-8444-555555555551", G2 = "11111111-2222-4333-8444-555555555552";
const G3 = "11111111-2222-4333-8444-555555555553", G4 = "11111111-2222-4333-8444-555555555554";

const PRODUCTS = [
  { ProductCode: "SKU-A", Guid: G1, ProductDescription: "Green tea", Barcode: "9300000000011", DefaultSellPrice: 12.5 },
  { ProductCode: "SKU-B", Guid: G2, ProductDescription: "Ceramic mug", Barcode: "", DefaultSellPrice: 18 },
  { ProductCode: "SKU-C", Guid: G3, ProductDescription: "", Barcode: "9300000000033", DefaultSellPrice: 5 },
  { ProductCode: "SKU-D", Guid: G4, ProductDescription: "Side plate", Barcode: "9300000000044" },
];
// SKU-LOW totals 4 across two warehouses (flagged at the default level of 5); SKU-OK totals 10.
const STOCK = [
  { ProductCode: "SKU-OK", ProductGuid: G1, WarehouseCode: "MAIN", QtyOnHand: 10 },
  { ProductCode: "SKU-LOW", ProductGuid: G2, WarehouseCode: "MAIN", QtyOnHand: 3 },
  { ProductCode: "SKU-LOW", ProductGuid: G2, WarehouseCode: "OVERFLOW", QtyOnHand: 1 },
];
const WOO = [
  { id: 7, sku: "", name: "Candle", regular_price: "9.00" },
  { id: 8, sku: "CAN-2", name: "Soap", regular_price: "4" },
];

const S: Settings = { family: "all", business_name: "Test Store", low_stock_qty: 5, retire_codes: [], woocommerce: false };

/** A context whose draft reads come from canned data. The runtime gate still decides which operations may run. */
function fakeCtx(store: MemoryStore, calls: string[], settings: Settings = S) {
  const ctx = context(WF, settings, store, NOW, () => {});
  ctx.draft = (async (a: any) => {
    if (!(WF.draft_ops[a.platform] ?? []).includes(a.op)) throw new Error(`${WF.id}: ${a.op} is not a draft operation`);
    calls.push(`${a.platform} ${a.op}`);
    const data = a.op === "docs.get_Products" ? { Pagination: {}, Items: PRODUCTS }
      : a.op === "docs.get_StockOnHand" ? { Pagination: {}, Items: STOCK }
      : a.op === "docs.get_products" ? WOO : undefined;
    if (data === undefined) throw new Error(`unfaked op ${a.op}`);
    return { status: 200, data, headers: new Headers() };
  }) as any;
  return ctx;
}

beforeEach(() => {
  // Test values only. The Unleashed signer reads these, so signed requests can be checked without a real key.
  process.env.UNLEASHED_API_ID = "test-id";
  process.env.UNLEASHED_API_KEY = "test-key";
  process.env.UNLEASHED_CLIENT_TYPE = "test-client";
  delete process.env.KIT_ALLOW_WRITES;
  // Any request that gets past the fake draft would hit this and fail the test.
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any) => { throw new Error(`network blocked in tests: ${String(url)}`); }) as any,
  });
});

test("the read crons only read: every call is a draft operation and nothing is queued", async () => {
  const store = new MemoryStore(), calls: string[] = [];
  await check(fakeCtx(store, calls, { ...S, woocommerce: true }));
  await stock(fakeCtx(store, calls, { ...S, woocommerce: true }));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => /docs\.get_/.test(c)), calls.join(", "));
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("check flags missing barcodes, descriptions, prices and WooCommerce SKUs", async () => {
  const store = new MemoryStore();
  await check(fakeCtx(store, [], { ...S, woocommerce: true }));
  const flags = Object.values(await store.list<Flag>("flags")).filter((f) => f.kind === "check" && f.status === "open");
  const reasons = flags.map((f) => `${f.platform}:${f.code}:${f.reason}`).sort();
  assert.deepEqual(reasons, [
    "unleashed:SKU-B:missing-barcode",
    "unleashed:SKU-C:missing-description",
    "unleashed:SKU-D:missing-price",
    "woocommerce:#7:missing-sku",
  ]);
});

test("WooCommerce is only read when the settings switch it on", async () => {
  const store = new MemoryStore(), calls: string[] = [];
  await check(fakeCtx(store, calls, S));
  assert.ok(!calls.some((c) => c.startsWith("woocommerce")));
  const calls2: string[] = [];
  await check(fakeCtx(new MemoryStore(), calls2, { ...S, woocommerce: true }));
  assert.ok(calls2.includes("woocommerce docs.get_products"));
});

test("stock flags a product whose total across warehouses is at or below the low-stock level", async () => {
  const store = new MemoryStore();
  await stock(fakeCtx(store, []));
  const low = Object.values(await store.list<Flag>("flags")).filter((f) => f.kind === "stock" && f.status === "open");
  assert.deepEqual(low.map((f) => f.code), ["SKU-LOW"]);
  assert.match(low[0].message, /4 on hand/);
});

test("re-runs keep first_seen and resolve a flag that no longer comes up", async () => {
  const store = new MemoryStore();
  await check(fakeCtx(store, []));
  const first = Object.values(await store.list<Flag>("flags")).find((f) => f.code === "SKU-B")!;
  await check(fakeCtx(store, []));
  const again = (await store.get<Flag>("flags", first.key))!;
  assert.equal(again.first_seen, first.first_seen);
  assert.equal(again.status, "open");
  // A product that now has a barcode drops out of the next run and resolves.
  PRODUCTS[1] = { ...PRODUCTS[1], Barcode: "9300000000022" } as any;
  try {
    await check(fakeCtx(store, []));
    assert.equal((await store.get<Flag>("flags", first.key))!.status, "resolved");
  } finally {
    PRODUCTS[1] = { ProductCode: "SKU-B", Guid: G2, ProductDescription: "Ceramic mug", Barcode: "", DefaultSellPrice: 18 } as any;
  }
});

test("retire queues one obsolete approval per listed product, as a live op, and re-runs never double-queue", async () => {
  const store = new MemoryStore();
  const settings = { ...S, retire_codes: ["SKU-A", "SKU-B"] };
  await retire(fakeCtx(store, [], settings));
  await retire(fakeCtx(store, [], settings));
  await retire(fakeCtx(store, [], settings));
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 2);
  for (const ap of approvals) {
    assert.equal(ap.status, "pending");
    assert.equal(ap.acts[0].op, "docs.post_Products_Obsolete_productGuid");
    assert.equal(ap.acts[0].platform, "unleashed");
  }
});

test("a live op cannot be run as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "unleashed", op: "docs.post_Products_Obsolete_productGuid", summary: "x" }), /not a draft operation/);
});

/** A fake Unleashed: answers the two reads and the obsolete write, and records every request it is sent. */
function fakeUnleashed(seen: { method: string; url: URL; headers: Record<string, string> }[]) {
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      seen.push({ method: init.method, url: u, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/Products") return json({ Pagination: {}, Items: PRODUCTS });
      if (u.pathname === "/StockOnHand") return json({ Pagination: {}, Items: STOCK });
      if (u.pathname.startsWith("/Products/Obsolete/")) return json({});
      throw new Error(`network blocked in tests: ${u.pathname}`);
    }) as any,
  });
}
const sigOf = (u: URL) => createHmac("sha256", "test-key").update(u.search.replace(/^\?/, ""), "utf8").digest("base64");

test("Unleashed reads go out signed: the signature matches the query string and nothing is written", async () => {
  const seen: { method: string; url: URL; headers: Record<string, string> }[] = [];
  fakeUnleashed(seen);
  const store = new MemoryStore();
  await check(context(WF, S, store, NOW, () => {}));
  assert.ok(seen.length >= 1);
  for (const r of seen) {
    assert.equal(r.method, "GET");
    assert.equal(r.headers["api-auth-id"], "test-id");
    assert.equal(r.headers["client-type"], "test-client");
    assert.equal(r.headers["api-auth-signature"], sigOf(r.url));
  }
  const flags = Object.values(await store.list<Flag>("flags")).filter((f) => f.status === "open").map((f) => f.code).sort();
  assert.deepEqual(flags, ["SKU-B", "SKU-C", "SKU-D"]);
});

test("an approved retirement is blocked by the write gate, and no request leaves", async () => {
  const store = new MemoryStore();
  await retire(fakeCtx(store, [], { ...S, retire_codes: ["SKU-A"] }));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner@test", NOW);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /write blocked/);
});

test("a retirement is sent, signed, only after approval and only with writes allowed", async () => {
  const seen: { method: string; url: URL; headers: Record<string, string> }[] = [];
  fakeUnleashed(seen);
  const store = new MemoryStore();
  await retire(context(WF, { ...S, retire_codes: ["SKU-A"] }, store, NOW, () => {}));
  assert.equal(seen.filter((r) => r.method !== "GET").length, 0, "nothing is written before approval");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  process.env.KIT_ALLOW_WRITES = "1";
  let done: Approval;
  try {
    done = await approve(WF, store, ap.id, "owner@test", NOW);
  } finally {
    delete process.env.KIT_ALLOW_WRITES;
  }
  assert.equal(done.status, "done", done.error);
  const posts = seen.filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.pathname, `/Products/Obsolete/${G1}`);
  assert.equal(posts[0].headers["api-auth-signature"], sigOf(posts[0].url));
});

test("the cron table exports every cron named in workflow.json", () => {
  for (const c of WF.crons as unknown as { entry: string }[]) assert.equal(typeof CRONS[c.entry], "function", `missing cron ${c.entry}`);
});

test("a full first page is a partial read: open flags are not resolved and no low-stock flag is raised", async () => {
  const store = new MemoryStore();
  // A flag from an earlier run, for a product that sits on a later page than the first.
  await store.put("flags", "old-flag", { key: "old-flag", kind: "check", platform: "unleashed", code: "SKU-PAGE-2", reason: "missing-barcode",
    message: "SKU-PAGE-2 has no barcode", first_seen: NOW.toISOString(), last_seen: NOW.toISOString(), status: "open" } satisfies Flag);
  const rows = Array.from({ length: 200 }, (_, i) => ({ ProductCode: `P-${i}`, Guid: G1, ProductDescription: "d", Barcode: "1", DefaultSellPrice: 1 }));
  const levels = Array.from({ length: 200 }, (_, i) => ({ ProductCode: `P-${i}`, ProductGuid: G1, WarehouseCode: "MAIN", QtyOnHand: 1 }));
  const ctx = context(WF, S, store, NOW, () => {});
  ctx.draft = (async (a: any) => ({ status: 200, data: { Pagination: {}, Items: a.op === "docs.get_Products" ? rows : levels }, headers: new Headers() })) as any;
  await check(ctx);
  assert.equal((await store.get<Flag>("flags", "old-flag"))!.status, "open", "a flag on a later page is not resolved by a partial read");
  await stock(ctx);
  assert.equal(Object.values(await store.list<Flag>("flags")).filter((f) => f.kind === "stock").length, 0, "stock totals on a partial read raise nothing");
});
