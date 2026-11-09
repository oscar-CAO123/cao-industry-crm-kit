// Retail artwork workflow tests. Every request goes to a fake network: no test reaches a real store.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { catalogue, listing } from "../industries/retail/workflows/fulfilment/artwork/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/retail/workflows/fulfilment/artwork/workflow.json", "utf8")) as WorkflowRecord;
const SITE = "shop.example.com.au";
const ASSET_HOST = "assets.example.com.au";
const EXISTING = `https://${SITE}/wp-content/uploads/tote-plain.jpg`;
const TOTE_FRONT = "https://assets.example.com.au/mockups/tote-navy-front.jpg";
const TOTE_BACK = "https://assets.example.com.au/mockups/tote-navy-back.jpg";
const MUG_FRONT = "https://assets.example.com.au/mockups/mug-front.jpg";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let products: any[] = [];

function fake() {
  hits = [];
  products = [
    { id: 101, name: "Tote bag, navy", sku: "TOTE-NVY", images: [{ id: 555, src: EXISTING, alt: "" }] },
    { id: 102, name: "Enamel mug", sku: "MUG-1", images: [] },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/wp-json/wc/v3/products" && m === "GET") {
        const page = Number(u.searchParams.get("page") ?? "1");
        return json(page === 1 ? products : []);
      }
      if (p === "/wp-json/wc/v3/products/batch" && m === "POST") {
        const upd: any[] = body?.update ?? [];
        for (const x of upd) {
          const pr = products.find((q) => q.id === x.id);
          if (pr) pr.images = x.images.map((i: any, n: number) => (i.id ? pr.images.find((q: any) => q.id === i.id) : { id: 700 + n, src: i.src, alt: i.alt }));
        }
        return json({ update: upd.map((x) => ({ id: x.id })) });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake();
  Object.assign(process.env, { WOOCOMMERCE_SITE: SITE, WOOCOMMERCE_CONSUMER_KEY: "ck_test_key", WOOCOMMERCE_CONSUMER_SECRET: "cs_test_secret", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft the live batch update, and cannot queue the read", async () => {
  const ctx = context(WF, { store: "woocommerce" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "woocommerce", op: "docs.post_products_batch", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "woocommerce", op: "docs.get_products", summary: "x" }), /not a live operation/);
});

test("catalogue reads the products, records them, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce" }, store, NOW, () => {});
  assert.deepEqual(await catalogue(ctx), { products: 2, without_images: 1, mockups_live: 0, mockups_waiting: 0 });
  assert.equal(writes().length, 0, "nothing written to the store");
  assert.equal((await store.get<any>("products", "102"))?.name, "Enamel mug");
});

test("listing queues each mockup set once, and sends nothing before approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await store.put("mockups", "set-tote", { product_id: 101, images: [{ src: TOTE_FRONT, alt: "Navy tote, front" }] });
  await store.put("mockups", "set-mug", { product_id: 102, images: [{ src: MUG_FRONT, alt: "Enamel mug, front" }, { src: TOTE_BACK, alt: "" }] });
  await catalogue(ctx);
  assert.deepEqual(await listing(ctx), { ready_for_approval: 2, rejected: 0, skipped: 0 });
  assert.deepEqual(await listing(ctx), { ready_for_approval: 2, rejected: 0, skipped: 0 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2, "re-runs never queue twice");
  assert.equal(writes().length, 0, "nothing written to the store by a cron");
});

test("approval sends the batch update: existing image kept by id, new images appended in order", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await store.put("mockups", "set-tote", { product_id: 101, images: [{ src: TOTE_FRONT, alt: "Navy tote, front" }] });
  await catalogue(ctx);
  await listing(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.equal(ap.acts[0].op, "docs.post_products_batch");
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const send = writes().find((h) => h.path === "/wp-json/wc/v3/products/batch")!;
  assert.deepEqual(send.body, { update: [{ id: 101, images: [{ id: 555 }, { src: TOTE_FRONT, alt: "Navy tote, front", position: 1 }] }] });
  assert.equal(products[0].images.length, 2, "the existing image is still on the product");
});

test("after approval the set shows as live, and listing does not queue it again", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await store.put("mockups", "set-mug", { product_id: 102, images: [{ src: MUG_FRONT, alt: "Enamel mug, front" }] });
  await catalogue(ctx);
  await listing(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  assert.deepEqual(await catalogue(ctx), { products: 2, without_images: 0, mockups_live: 1, mockups_waiting: 0 });
  await listing(ctx);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "the approved set is not queued again");
  assert.equal(writes().filter((h) => h.path.endsWith("/batch")).length, 1, "the store was written once");
});

test("a mockup image on a host the business does not control is rejected before anything is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("mockups", "steered", { product_id: 102, images: [{ src: "https://attacker.example.net/mug.jpg", alt: "" }] });
  assert.deepEqual(await listing(ctx), { ready_for_approval: 0, rejected: 1, skipped: 0 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("listing refuses to run until asset_hosts is set", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10 }, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("mockups", "set-mug", { product_id: 102, images: [{ src: MUG_FRONT, alt: "" }] });
  await assert.rejects(listing(ctx), /asset_hosts/);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("unsafe mockup sets are rejected before anything is queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 2, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await catalogue(ctx);
  await store.put("mockups", "plain-http", { product_id: 102, images: [{ src: "http://assets.example.com.au/mug.jpg", alt: "" }] });
  await store.put("mockups", "too-long-alt", { product_id: 102, images: [{ src: MUG_FRONT, alt: "x".repeat(126) }] });
  await store.put("mockups", "too-many", { product_id: 101, images: [{ src: TOTE_FRONT, alt: "" }, { src: TOTE_BACK, alt: "" }] });
  assert.deepEqual(await listing(ctx), { ready_for_approval: 0, rejected: 3, skipped: 0 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("a set for a product the catalogue has not read waits, and a blocked deploy cannot write", async () => {
  const store = new MemoryStore(), ctx = context(WF, { store: "woocommerce", max_images: 10, asset_hosts: [ASSET_HOST] }, store, NOW, () => {});
  await store.put("mockups", "unknown", { product_id: 999, images: [{ src: MUG_FRONT, alt: "" }] });
  assert.deepEqual(await listing(ctx), { ready_for_approval: 0, rejected: 0, skipped: 1 });
  await store.put("mockups", "set-mug", { product_id: 102, images: [{ src: MUG_FRONT, alt: "" }] });
  await catalogue(ctx);
  await listing(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  process.env.KIT_ALLOW_WRITES = "0";
  const blocked = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(blocked.status, "failed");
  assert.equal(writes().length, 0, "the SDK gate stopped the write before the socket opened");
});
