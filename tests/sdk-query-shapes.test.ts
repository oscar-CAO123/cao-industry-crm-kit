// Query shapes (Productive, Cliniko), read-only POSTs (HubSpot CRM v3 search, Square search and retrieve).
// Plans need no network. Two reads run through a fake transport; nothing reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { plan, callOperation } from "../core/sdk/call.ts";

const PRODUCTIVE_LIST = "activities-index";
const CLINIKO_LIST = "appointment-type.listappointmenttypes";
const HUBSPOT_COMPANIES = "crm-companies-3.get-/crm/v3/objects/companies_getPage";
const HUBSPOT_CREATE = "crm-companies-3.post-/crm/v3/objects/companies_create";
const HUBSPOT_SEARCH = "crm-orders-3.post-/crm/v3/objects/orders/search";
const SQUARE_SEARCH = "api.SearchOrders";
const SQUARE_CATALOG = "api.SearchCatalogItems";
const SQUARE_BATCH = "api.BatchRetrieveInventoryChanges";
const SQUARE_REFUND = "api.RefundPayment";

let hits: { url: string; method: string }[] = [];

beforeEach(() => {
  hits = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      hits.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
    sleep: async () => {},
    log: () => {},
  });
  process.env.HUBSPOT_ACCESS_TOKEN = "hs-test";
  process.env.SQUARE_ACCESS_TOKEN = "sq-test";
  delete process.env.KIT_ALLOW_WRITES;
});

test("Productive: a filter goes out as filter[field][op]=value, and include and sort as comma lists", async () => {
  const r = await plan("productive", PRODUCTIVE_LIST, {
    params: { filter: { person_id: 123, created_at: { gt: "2026-11-01" } }, include: ["person", "company"], sort: "-created_at" },
  });
  assert.equal(r.url, "https://api.productive.io/api/v2/activities?include=person%2Ccompany&sort=-created_at"
    + "&filter%5Bperson_id%5D=123&filter%5Bcreated_at%5D%5Bgt%5D=2026-11-01");
  assert.equal(r.kind, "read");
  assert.equal(r.readPost, false);
});

test("Productive: a plain string filter is sent unchanged", async () => {
  const r = await plan("productive", PRODUCTIVE_LIST, { params: { filter: "person_id" } });
  assert.equal(new URL(r.url).searchParams.get("filter"), "person_id");
});

test("Productive: a list value holding a comma, and a filter field with odd characters, are refused before any request", async () => {
  await assert.rejects(() => plan("productive", PRODUCTIVE_LIST, { params: { include: ["person,company"] } }), /may not hold a comma/);
  await assert.rejects(() => plan("productive", PRODUCTIVE_LIST, { params: { filter: { "a b": 1 } } }), /not allowed/);
  assert.equal(hits.length, 0);
});

test("Cliniko: q[] repeats its key, so q[]=a&q[]=b", async () => {
  const r = await plan("cliniko", CLINIKO_LIST, { params: { "q[]": ["a", "b"] } });
  assert.ok(r.url.startsWith("https://api.au1.cliniko.com/v1/appointment_types?"), r.url);
  assert.equal(new URL(r.url).search, "?q%5B%5D=a&q%5B%5D=b");
});

test("Cliniko: other list params keep today's JSON form, because their own format is not confirmed", async () => {
  const r = await plan("cliniko", CLINIKO_LIST, { params: { sort: ["name"] } });
  assert.equal(new URL(r.url).searchParams.get("sort"), '["name"]');
});

test("other platforms are unchanged: a list value is still one JSON string", async () => {
  const r = await plan("hubspot", HUBSPOT_COMPANIES, { params: { properties: ["name", "domain"] } });
  assert.equal(new URL(r.url).searchParams.get("properties"), '["name","domain"]');
  assert.equal(new URL(r.url).search, "?properties=%5B%22name%22%2C%22domain%22%5D");
});

test("HubSpot: a CRM v3 search is planned and sent as a read POST, with no KIT_ALLOW_WRITES", async () => {
  const body = { filterGroups: [] };
  const r = await plan("hubspot", HUBSPOT_SEARCH, { body });
  assert.equal(r.method, "POST");
  assert.equal(r.kind, "read");
  assert.equal(r.readPost, true);
  assert.equal(r.url, "https://api.hubapi.com/crm/v3/objects/orders/search");
  await callOperation("hubspot", HUBSPOT_SEARCH, { body });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "POST");
});

test("HubSpot: a CRM v3 create is still a write and is blocked without KIT_ALLOW_WRITES", async () => {
  const input = { body: { properties: { name: "Acme" } } };
  const r = await plan("hubspot", HUBSPOT_CREATE, input);
  assert.equal(r.kind, "write");
  assert.equal(r.readPost, false);
  await assert.rejects(() => callOperation("hubspot", HUBSPOT_CREATE, input), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("Square: search and batch retrieve POSTs are planned as reads, on their own paths", async () => {
  const cases: [string, string][] = [
    [SQUARE_SEARCH, "https://connect.squareup.com/v2/orders/search"],
    [SQUARE_CATALOG, "https://connect.squareup.com/v2/catalog/search-catalog-items"],
    [SQUARE_BATCH, "https://connect.squareup.com/v2/inventory/changes/batch-retrieve"],
  ];
  for (const [op, url] of cases) {
    const r = await plan("square", op, { body: {} });
    assert.equal(r.method, "POST", op);
    assert.equal(r.kind, "read", op);
    assert.equal(r.readPost, true, op);
    assert.equal(r.url, url, op);
  }
});

test("Square: a search runs with no KIT_ALLOW_WRITES, and a refund is still blocked", async () => {
  await callOperation("square", SQUARE_SEARCH, { body: {} });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "POST");
  const refund = await plan("square", SQUARE_REFUND, { body: { payment_id: "PAY_1", amount_money: { amount: 100, currency: "AUD" } } });
  assert.equal(refund.kind, "write");
  assert.equal(refund.readPost, false);
  await assert.rejects(() => callOperation("square", SQUARE_REFUND, { body: { payment_id: "PAY_1", amount_money: { amount: 100, currency: "AUD" } } }), WriteBlocked);
  assert.equal(hits.length, 1, "the refund never reached the network");
});
