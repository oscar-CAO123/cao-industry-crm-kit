// Site-sourcing workflow tests. Every request goes to a fake network: no test reaches a real Domain account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { scan, deskCheck, enquire } from "../industries/all/workflows/sales/site-sourcing/index.ts";
import type { Candidate, Settings } from "../industries/all/workflows/sales/site-sourcing/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/site-sourcing/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T21:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

const LISTINGS = [
  { type: "PropertyListing", listing: { id: 1001, headline: "Land parcel near the park", propertyDetails: { state: "NSW", propertyType: "Land", landArea: 750, suburb: "NEWTOWN", postcode: "2042", displayableAddress: "1 Test St, Newtown", latitude: -33.89, longitude: 151.17 } } },
  { type: "PropertyListing", listing: { id: 1002, headline: "Small block", propertyDetails: { state: "NSW", propertyType: "Land", landArea: 300, suburb: "NEWTOWN", postcode: "2042", displayableAddress: "2 Test St, Newtown", latitude: -33.89, longitude: 151.17 } } },
  { type: "Project", listing: { id: 1003, headline: "Apartment project" } },
  { type: "PropertyListing", listing: { id: "<script>1", propertyDetails: { state: "NSW", suburb: "NEWTOWN", postcode: "2042" } } },
];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/v1/listings/residential/_search" && m === "POST") return json(LISTINGS);
      if (p === "/v2/suburbPerformanceStatistics/NSW/NEWTOWN/2042" && m === "GET") return json({ medianSoldPrice: 1500000 });
      if (p === "/v2/schools/-33.89/151.17" && m === "GET") return json([{ name: "Newtown Public" }]);
      if (p === "/v1/enquiries" && m === "POST") return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const settings = (over: Partial<Settings> = {}): Settings => ({
  business_name: "Test Developments",
  search: { listing_type: "Sale", locations: [{ state: "NSW", suburb: "Newtown", postcode: "2042" }], property_types: [], min_land_area: 600 },
  enquiry: { sender: { firstName: "Sam", lastName: "Lee", email: "sam@example.com.au", phoneNumber: "0412 345 678", postcode: "2000" },
             subject: "Enquiry about {address}", message: "Hello, I am interested in {address}. Could we talk?" },
  ...over,
});
const enquiries = () => hits.filter((h) => h.path === "/v1/enquiries");
const shortlist = async (store: MemoryStore, key: string) => {
  const c = await store.get<Candidate>("candidates", key);
  await store.put("candidates", key, { ...c, status: "shortlisted" });
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { DOMAIN_API_KEY: "d", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run the enquiry and a cron cannot queue a search", async () => {
  const ctx = context(WF, settings(), new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "domain", op: "docs.post_v1_enquiries", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "domain", op: "docs.post_v1_listings_residential_search", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("scan keeps listings that match, drops the rest, and a second scan adds nothing", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, settings(), store, NOW, () => {});
  const first = await scan(ctx);
  assert.deepEqual(first, { found: 2, added: 1 });
  const search = hits.find((h) => h.path === "/v1/listings/residential/_search")!;
  assert.equal(search.body.listingType, "Sale");
  assert.equal(search.body.locations[0].suburb, "Newtown");
  const kept = await store.get<Candidate>("candidates", "domain:1001");
  assert.equal(kept?.listing_id, "1001");
  assert.equal(kept?.status, "new");
  assert.equal(await store.get("candidates", "domain:1002"), undefined);
  const second = await scan(ctx);
  assert.equal(second.added, 0);
  assert.equal(Object.keys(await store.list("candidates")).length, 1);
});

test("desk-check reads suburb statistics and schools, and sends nothing", async () => {
  const store = new MemoryStore();
  await scan(context(WF, settings(), store, NOW, () => {}));
  const out = await deskCheck(context(WF, settings(), store, NOW, () => {}));
  assert.deepEqual(out, { checked: 1, failed: 0 });
  const c = await store.get<Candidate>("candidates", "domain:1001");
  assert.equal(c?.status, "checked");
  assert.equal((c?.desk?.suburb_performance as any).medianSoldPrice, 1500000);
  assert.deepEqual(c?.desk?.schools, [{ name: "Newtown Public" }]);
  assert.equal(enquiries().length, 0);
});

test("desk-check refuses a location that could change the URL, and never calls the network for it", async () => {
  const store = new MemoryStore();
  await store.put("candidates", "domain:9", { key: "domain:9", platform: "domain", listing_id: "9", address: "x", state: "NSW", suburb: "../admin", postcode: "2042", status: "new", found: NOW.toISOString() } satisfies Candidate);
  const out = await deskCheck(context(WF, settings(), store, NOW, () => {}));
  assert.deepEqual(out, { checked: 0, failed: 1 });
  assert.equal(hits.filter((h) => h.path.includes("suburbPerformance")).length, 0);
  assert.equal((await store.get<Candidate>("candidates", "domain:9"))?.status, "new");
});

test("a cron never sends an enquiry, even for a shortlisted site, and queues it only once", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, settings(), store, NOW, () => {});
  await scan(ctx);
  await deskCheck(ctx);
  await shortlist(store, "domain:1001");
  const out = await enquire(ctx);
  assert.deepEqual(out, { queued: 1, recorded: 0 });
  assert.equal(enquiries().length, 0);
  const id = approvalId(WF.id, "enquire:domain:1001");
  const ap = await store.get<Approval>("approvals", id);
  assert.equal(ap?.status, "pending");
  assert.equal(ap?.acts[0].op, "docs.post_v1_enquiries");
  assert.equal((await store.get<Candidate>("candidates", "domain:1001"))?.status, "enquiry-queued");
  await enquire(ctx);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  assert.equal(enquiries().length, 0);
});

test("an approved enquiry goes to the listing with the sender and the owner's text, and the site is then enquired", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, settings(), store, NOW, () => {});
  await scan(ctx); await deskCheck(ctx); await shortlist(store, "domain:1001"); await enquire(ctx);
  const id = approvalId(WF.id, "enquire:domain:1001");
  const ap = await approve(WF, store, id, "oscar", NOW);
  assert.equal(ap.status, "done");
  const sent = enquiries();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.referenceId, "1001");
  assert.equal(sent[0].body.enquiryType, "listing");
  assert.equal(sent[0].body.deliveryMethod, "email");
  assert.equal(sent[0].body.sender.email, "sam@example.com.au");
  assert.match(sent[0].body.message, /1 Test St, Newtown/);
  await enquire(ctx);
  assert.equal((await store.get<Candidate>("candidates", "domain:1001"))?.status, "enquired");
});

test("a rejected enquiry is never sent and the site is marked skipped", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, settings(), store, NOW, () => {});
  await scan(ctx); await deskCheck(ctx); await shortlist(store, "domain:1001"); await enquire(ctx);
  await reject(WF, store, approvalId(WF.id, "enquire:domain:1001"), "oscar", NOW);
  await enquire(ctx);
  assert.equal((await store.get<Candidate>("candidates", "domain:1001"))?.status, "skipped");
  assert.equal(enquiries().length, 0);
});

test("bad settings stop before any network call or queued approval", async () => {
  const store = new MemoryStore();
  await assert.rejects(scan(context(WF, settings({ search: { listing_type: "Sale", locations: [{ state: "NSW", suburb: "x;DROP", postcode: "2042" }] } }), store, NOW, () => {})), /bad suburb/);
  assert.equal(hits.length, 0);
  const bad = settings({ enquiry: { sender: { firstName: "Sam", lastName: "Lee", email: "not-an-email", phoneNumber: "0412 345 678", postcode: "2000" }, subject: "s", message: "m" } });
  await store.put("candidates", "domain:1001", { key: "domain:1001", platform: "domain", listing_id: "1001", address: "1 Test St", state: "NSW", suburb: "NEWTOWN", postcode: "2042", status: "shortlisted", found: NOW.toISOString() } satisfies Candidate);
  await assert.rejects(enquire(context(WF, bad, store, NOW, () => {})), /sender email is not valid/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal(enquiries().length, 0);
});
