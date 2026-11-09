// Add-proposal workflow tests. Every request goes to a fake network: no test reaches a real HubSpot account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { draft, status, publish, CRONS } from "../industries/professional-services/workflows/sales/add-proposal/index.ts";
import fs from "node:fs";

const DIR = "industries/professional-services/workflows/sales/add-proposal";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { ...JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8")), hubspot: {
  ...JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8")).hubspot,
  contact_association: { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 } } };
const NOW = new Date("2026-11-08T00:00:00Z");
const CONTACT = "5501", QUOTE = "9001";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let quoteStatus = "DRAFT";
const writes = () => hits.filter((h) => h.method !== "GET");

function fake() {
  hits = []; quoteStatus = "DRAFT";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/crm/v3/objects/quotes" && m === "POST") return json({ id: QUOTE });
      if (p === `/crm/v3/objects/quotes/${QUOTE}` && m === "GET") return json({ id: QUOTE, properties: { hs_status: quoteStatus } });
      if (p === `/crm/v3/objects/quotes/${QUOTE}` && m === "PATCH") return json({ id: QUOTE });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const seed = async (store: MemoryStore) => store.put("proposals", "enq-1", {
  id: "enq-1", contact_id: CONTACT, title: "Environmental monitoring proposal", scope: "Quarterly air monitoring", fee_ex_gst: 4800, status: "scoped", created: NOW.toISOString(),
});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "hubspot", op: "crm-quotes-3.patch-/crm/v3/objects/quotes/{quoteId}_update", input: { params: { quoteId: QUOTE }, body: {} }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "hubspot", op: "crm-quotes-3.post-/crm/v3/objects/quotes_create", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("draft cron creates one draft quote on the contact and publishes nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await seed(store);
  assert.deepEqual(await draft(ctx), { drafted: 1 });
  assert.deepEqual(await draft(ctx), { drafted: 0 }, "a rerun never makes a second quote");
  const creates = writes();
  assert.equal(creates.length, 1);
  assert.equal(creates[0].path, "/crm/v3/objects/quotes");
  assert.equal(creates[0].body.properties.hs_title, "Environmental monitoring proposal");
  assert.equal(creates[0].body.properties.hs_quote_amount, "4800");
  assert.deepEqual(creates[0].body.associations[0].to, { id: CONTACT });
  const p = await store.get<any>("proposals", "enq-1");
  assert.equal(p.status, "drafted");
  assert.equal(p.quote_id, QUOTE);
});

test("publish cron only queues: nothing is published until a person approves", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await seed(store); await draft(ctx);
  assert.deepEqual(await publish(ctx), { queued: 1 });
  assert.deepEqual(await publish(ctx), { queued: 0 }, "re-runs never queue twice");
  assert.equal(writes().filter((h) => h.method === "PATCH").length, 0, "no PATCH before approval");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["crm-quotes-3.patch-/crm/v3/objects/quotes/{quoteId}_update"]);
  assert.equal((await store.get<any>("proposals", "enq-1")).status, "publish-queued");
});

test("approval publishes the quote, and the status cron reads acceptance back", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await seed(store); await draft(ctx); await publish(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  const patch = writes().find((h) => h.method === "PATCH")!;
  assert.equal(patch.path, `/crm/v3/objects/quotes/${QUOTE}`);
  assert.deepEqual(patch.body, { properties: { hs_status: "PUBLISHED" } });
  quoteStatus = "PUBLISHED";
  assert.deepEqual(await status(ctx), { changed: 1 });
  assert.equal((await store.get<any>("proposals", "enq-1")).status, "published");
  quoteStatus = "ACCEPTED";
  assert.deepEqual(await status(ctx), { changed: 1 });
  assert.equal((await store.get<any>("proposals", "enq-1")).status, "accepted");
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("a rejected publish, once reset to drafted, queues a new approval a person can approve", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await seed(store); await draft(ctx); await publish(ctx);
  const [first] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, first.id, "owner", NOW);
  await store.put("proposals", "enq-1", { ...(await store.get<any>("proposals", "enq-1")), status: "drafted" });   // the documented reset
  assert.deepEqual(await publish(ctx), { queued: 1 });
  const waiting = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(waiting.length, 1, "a new approval is waiting for a person");
  assert.notEqual(waiting[0].id, first.id);
  assert.equal((await store.get<any>("proposals", "enq-1")).status, "publish-queued");
  assert.equal((await approve(WF, store, waiting[0].id, "owner", NOW)).status, "done");
  assert.equal(writes().filter((h) => h.method === "PATCH").length, 1, "the approved publish runs once");
  assert.deepEqual(await publish(ctx), { queued: 0 }, "a published quote is not queued again");
});

test("the crons match the workflow record's entries", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});
