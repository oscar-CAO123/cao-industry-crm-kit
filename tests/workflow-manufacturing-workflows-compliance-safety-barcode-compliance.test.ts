// Barcode compliance workflow tests. Unleashed is signed by core, so the fake network answers Unleashed only and
// fails anything else. Each request is recorded, so a test can show what left the building and when.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { checkBarcodes, queueFixes } from "../industries/manufacturing/workflows/compliance-safety/barcode-compliance/index.ts";
import { gtinProblems, type Fix, type Finding } from "../industries/manufacturing/workflows/compliance-safety/barcode-compliance/types.ts";

const DIR = "industries/manufacturing/workflows/compliance-safety/barcode-compliance";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS = { business_name: "Test Manufacturing" };
const NOW = new Date("2026-11-09T00:00:00Z");
const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const UNLEASHED_HOST = "api.unleashedsoftware.com";
const KEYS = { UNLEASHED_API_ID: "test-api-id", UNLEASHED_API_KEY: "test-api-key", UNLEASHED_CLIENT_TYPE: "test-client-type" };
// Every call in this file has an empty query string, so the signature is the HMAC of "".
const SIG_EMPTY_QUERY = createHmac("sha256", KEYS.UNLEASHED_API_KEY).update("", "utf8").digest("base64");

interface Sent { method: string; path: string; id: string | null; sig: string | null; clientType: string | null; body?: any }
let sent: Sent[] = [];
let fake: { list: unknown[]; pages: number; products: Record<string, unknown> };

beforeEach(() => {
  sent = [];
  fake = { list: [], pages: 1, products: {} };
  process.env.KIT_ALLOW_WRITES = "1";
  Object.assign(process.env, KEYS);
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: string, init: any) => {
      const u = new URL(url);
      if (u.hostname !== UNLEASHED_HOST) throw new Error(`network touched outside Unleashed in a test: ${u.hostname}`);
      const h = init.headers as Record<string, string>;
      const method = String(init.method);
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ method, path: u.pathname, id: h["api-auth-id"] ?? null, sig: h["api-auth-signature"] ?? null, clientType: h["client-type"] ?? null, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && u.pathname === "/Products") return json({ Pagination: { NumberOfPages: fake.pages }, Items: fake.list });
      const m = /^\/Products\/([^/]+)$/.exec(u.pathname);
      if (m && method === "GET") return fake.products[m[1]] ? json(fake.products[m[1]]) : json({ error: "not found" }, 404);
      if (m && method === "POST") return json(body);
      return json({ error: "not in this test" }, 404);
    }) as any,
  });
});

const reads = () => sent.filter((s) => s.method === "GET").map((s) => s.path);
const writes = () => sent.filter((s) => s.method !== "GET");

const product = (n: number, code: string, barcode: string | null, obsolete = false) =>
  ({ Guid: G(n), ProductCode: code, ProductDescription: `${code} description`, Barcode: barcode, Obsolete: obsolete, IsSellable: true });

const LIST = [
  product(1, "GOOD13", "4006381333931"),   // valid GTIN-13
  product(2, "BADCHK", "4006381333932"),   // wrong check digit
  product(3, "LETTERS", "40063A1333931"),  // not digits only
  product(4, "NOBAR", null),               // no barcode
  product(5, "DUPA", "96385074"),          // valid GTIN-8
  product(6, "DUPB", "000096385074"),      // the same GTIN, zero-padded to 12
  product(7, "OLD", "4006381333932", true) // obsolete: not checked
];

test("GS1 rules: digits only, 8/12/13/14 digits, and a correct check digit", () => {
  assert.deepEqual(gtinProblems("4006381333931"), []);
  assert.deepEqual(gtinProblems("96385074"), []);
  assert.deepEqual(gtinProblems("000096385074"), []);
  assert.deepEqual(gtinProblems("4006381333932"), ["check digit is wrong"]);
  assert.deepEqual(gtinProblems("40063A1333931"), ["not digits only"]);
  assert.match(gtinProblems("12345")[0], /5 digits/);
  assert.deepEqual(gtinProblems(""), ["no barcode"]);
});

test("a read is signed and reaches Unleashed through the gate", async () => {
  const base = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  fake.list = LIST;
  const r = await base.draft<any>({ platform: "unleashed", op: "docs.get_Products", summary: "read" });
  assert.equal(r.status, 200);
  assert.equal(r.data.Items.length, LIST.length);
  assert.deepEqual(reads(), ["/Products"]);
  assert.equal(sent[0].id, KEYS.UNLEASHED_API_ID);
  assert.equal(sent[0].sig, SIG_EMPTY_QUERY, "api-auth-signature is the HMAC of the query string");
  assert.equal(sent[0].clientType, KEYS.UNLEASHED_CLIENT_TYPE);
});

test("a cron cannot draft a live operation or queue a read", async () => {
  const base = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(base.draft({ platform: "unleashed", op: "docs.post_Products_id", summary: "x" }), /not a draft operation/);
  await assert.rejects(base.queue({ platform: "unleashed", op: "docs.get_Products", summary: "x" }), /not a live operation/);
  assert.equal(sent.length, 0);
});

test("check-barcodes flags what fails, skips obsolete products, and queues nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  fake.list = LIST;
  const r = await checkBarcodes(ctx);
  assert.deepEqual(r, { products: 7, flagged: 5, partial: false });
  const f = async (n: number) => store.get<Finding>("barcode-findings", G(n));
  assert.equal((await f(1))!.status, "ok");
  assert.deepEqual((await f(2))!.problems, ["check digit is wrong"]);
  assert.deepEqual((await f(3))!.problems, ["not digits only"]);
  assert.deepEqual((await f(4))!.problems, ["no barcode"]);
  assert.match((await f(5))!.problems.join(), /same barcode as DUPB/);
  assert.match((await f(6))!.problems.join(), /same barcode as DUPA/);
  assert.equal(await f(7), undefined, "obsolete products are not checked");
  assert.deepEqual(reads(), ["/Products"], "only the product list is read");
  assert.equal(writes().length, 0, "a check sends no write");
  assert.equal(Object.keys(await store.list("approvals")).length, 0, "a check never queues anything");
});

test("a catalogue with more pages is checked in part and the run says so", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  fake.list = LIST;
  fake.pages = 3;
  const r = await checkBarcodes(ctx);
  assert.equal(r.partial, true);
  const latest = await store.get<any>("barcode-runs", "latest");
  assert.equal(latest.partial, true);
});

test("queue-fixes queues one barcode update per recorded fix, once, and refuses a bad GTIN", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  fake.products[G(2)] = product(2, "BADCHK", "4006381333932");
  await store.put("barcode-fixes", "fix-good", { product: G(2), barcode: "4006381333931" } satisfies Fix);
  await store.put("barcode-fixes", "fix-badgtin", { product: G(2), barcode: "4006381333932" } satisfies Fix);
  await store.put("barcode-fixes", "fix-badid", { product: "not-a-guid", barcode: "4006381333931" } satisfies Fix);

  assert.deepEqual(await queueFixes(ctx), { queued: 1, refused: 2 });
  assert.deepEqual(await queueFixes(ctx), { queued: 0, refused: 2 }, "a re-run queues nothing new");
  assert.deepEqual(reads(), [`/Products/${G(2)}`], "the product is read once, not on the re-run");
  assert.equal(writes().length, 0, "queuing sends no write");

  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "one approval for the one good fix");
  const act = approvals[0].acts[0];
  assert.equal(act.op, "docs.post_Products_id");
  assert.equal(act.input!.params!.productGuid, G(2));
  const body = act.input!.body as Record<string, unknown>;
  assert.equal(body.Barcode, "4006381333931");
  assert.equal(body.ProductCode, "BADCHK", "the rest of the product is sent as read");
  assert.equal(approvals[0].status, "pending", "queued, never run by the cron");
  assert.equal((await store.get<Fix>("barcode-fixes", "fix-good"))!.approval, approvals[0].id);
});

test("an approved barcode update reaches Unleashed only after approval, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  fake.products[G(2)] = product(2, "BADCHK", "4006381333932");
  await store.put("barcode-fixes", "fix-good", { product: G(2), barcode: "4006381333931" } satisfies Fix);
  await queueFixes(ctx);
  assert.equal(writes().length, 0, "nothing is written before approval");

  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done", done.error);
  assert.equal(writes().length, 1, "one POST after approval");
  const [w] = writes();
  assert.equal(w.method, "POST");
  assert.equal(w.path, `/Products/${G(2)}`, "the product guid goes in the path");
  assert.equal(w.sig, SIG_EMPTY_QUERY, "the write is signed too");
  assert.equal(w.body.Barcode, "4006381333931");
  assert.equal(w.body.ProductCode, "BADCHK");

  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(writes().length, 1, "a second approval does not send the write again");
});

test("an approved barcode update is refused without KIT_ALLOW_WRITES and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  fake.products[G(2)] = product(2, "BADCHK", "4006381333932");
  await store.put("barcode-fixes", "fix-good", { product: G(2), barcode: "4006381333931" } satisfies Fix);
  await queueFixes(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  delete process.env.KIT_ALLOW_WRITES;
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /write blocked/i);
  assert.equal(writes().length, 0);
});
