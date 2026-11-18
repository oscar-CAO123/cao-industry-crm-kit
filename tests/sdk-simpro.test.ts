// Simpro: every client runs its own build, so the key may go only to that build, and companyID is the client's own.
// Fake network only: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { load, callOperation, plan, sendPrepared } from "../core/sdk/call.ts";

type Hit = { url: string; method: string; headers: Record<string, string> };
let hits: Hit[] = [];

beforeEach(() => {
  hits = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      hits.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {} });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
    sleep: async () => {},
    log: () => {},
  });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SIMPRO_ACCESS_TOKEN: "sp-test", SIMPRO_BUILD: "acme-electrical", SIMPRO_COMPANY_ID: "0" });
  delete process.env.SIMPRO_DOMAIN;
  delete process.env.KIT_ALLOW_WRITES;
});

const JOBS = "get /api/v1.0/companies/{companyID}/jobs/";
const auth = (h: Hit) => Object.entries(h.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];

test("simpro: the platform is generated from the spec with every call", () => {
  const p = load("simpro");
  assert.equal(p.platform.counts.operations, 1494);
  assert.equal(p.ops.size, 1494);
  assert.ok(p.ops.has(JOBS));
});

test("simpro: a read goes to the client's own build with the bearer key, and companyID is filled from the secret store", async () => {
  await callOperation("simpro", JOBS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "https://acme-electrical.simprosuite.com/api/v1.0/companies/0/jobs/");
  assert.equal(auth(hits[0]), "Bearer sp-test");
});

test("simpro: another company in a multi-company build is refused before the network", async () => {
  await assert.rejects(() => callOperation("simpro", JOBS, { params: { companyID: "5" } }), /must be the client's own/);
  // A value that answers "0" when checked and "5" when the address is built: it is turned into text once.
  let n = 0;
  const shifty = { toString: () => (n++ ? "5" : "0") };
  await callOperation("simpro", JOBS, { params: { companyID: shifty } }).catch(() => {});
  assert.ok(hits.every((h) => h.url.includes("/companies/0/")), "the checked value is the value sent");
  hits = [];
  for (const k of ["company_id", "Company-ID", "COMPANY_ID"]) await assert.rejects(() => callOperation("simpro", JOBS, { params: { [k]: "5" } }), /not allowed/, k);
  // In a write body, at the top level and in any spelling, the company is the client's own too.
  const POST = "post /api/v1.0/companies/{companyID}/jobs/";
  for (const k of ["companyID", "CompanyID", "company_id"]) await assert.rejects(() => plan("simpro", POST, { body: { [k]: "5", Type: "Service" } }), /in the body must be the client's own/, k);
  await assert.rejects(() => plan("simpro", POST, { body: { CompanyID: { id: 0 } } }), /in the body must be the client's own/);
  await plan("simpro", POST, { body: { CompanyID: 0, Type: "Service" } });
  assert.equal(hits.length, 0);
});

test("simpro: the build comes from the secret store only, and the domain is one of Simpro's two", async () => {
  await callOperation("simpro", JOBS, { server: { build: "someone-else", domain: "example.org" } });
  assert.equal(new URL(hits[0].url).hostname, "acme-electrical.simprosuite.com", "a caller cannot move the key to another build or domain");
  process.env.SIMPRO_DOMAIN = "simprocloud.com";
  await callOperation("simpro", JOBS);
  assert.equal(new URL(hits[1].url).hostname, "acme-electrical.simprocloud.com");
  process.env.SIMPRO_DOMAIN = "example.org";
  await assert.rejects(() => callOperation("simpro", JOBS));
  process.env.SIMPRO_DOMAIN = "simprosuite.com";
  process.env.SIMPRO_BUILD = "acme.example.org/x";
  await assert.rejects(() => callOperation("simpro", JOBS));
  assert.equal(hits.length, 2);
});

test("simpro: reads that return the webhook signing secret or a token-bearing payment link are gated like writes", async () => {
  const gated: [string, Record<string, string>][] = [
    ["get /api/v1.0/companies/{companyID}/setup/webhooks/{webhookID}", { webhookID: "1" }],
    ["get /api/v1.0/companies/{companyID}/invoices/{invoiceID}/getInvoicePaymentLink/", { invoiceID: "1" }],
    ["get /api/v1.0/companies/{companyID}/customers/{customerID}/statements/paymentLink/", { customerID: "1" }],
  ];
  for (const [id, params] of gated) {
    assert.equal(load("simpro").ops.get(id)?.kind, "write", id);
    await assert.rejects(() => callOperation("simpro", id, { params }), WriteBlocked);
  }
  assert.equal(hits.length, 0);
});

test("simpro: lists go as comma lists, and reads take Simpro's column filters but never a key-shaped name", async () => {
  await callOperation("simpro", JOBS, { params: { columns: ["ID", "Name"], orderby: ["-DateIssued"], Name: "Comp%", ID: "gt(5)", display: "all" } });
  const q = new URL(hits[0].url).searchParams;
  assert.equal(q.get("columns"), "ID,Name");
  assert.equal(q.get("orderby"), "-DateIssued");
  assert.equal(q.get("Name"), "Comp%");
  assert.equal(q.get("ID"), "gt(5)");
  assert.equal(q.get("display"), "all");
  await assert.rejects(() => callOperation("simpro", JOBS, { params: { access_token: "x" } }), /not allowed/);
  await assert.rejects(() => plan("simpro", "post /api/v1.0/companies/{companyID}/jobs/", { params: { Name: "x" } }), /unknown param/, "free-form inputs are for reads only");
  // Another company cannot ride in as a filter in another case, and no input asks the server to swap the method.
  for (const name of ["CompanyID", "companyid", "COMPANYID", "_method", "http_method", "X_HTTP_Method_Override"]) {
    await assert.rejects(() => callOperation("simpro", JOBS, { params: { [name]: "5" } }), /not allowed/, name);
    await assert.rejects(() => callOperation("simpro", "get /api/v1.0/currentUser/", { params: { [name]: "5" } }), /not allowed/, name);
  }
  assert.equal(hits.length, 1);
});

test("simpro: form downloads fill their template id (the spec types it in the path)", async () => {
  await callOperation("simpro", "get /api/v1.0/companies/{companyID}/jobs/{jobID}/viewForm/{formTemplateID}", { params: { jobID: "7", formTemplateID: "3" } });
  assert.equal(hits[0].url, "https://acme-electrical.simprosuite.com/api/v1.0/companies/0/jobs/7/viewForm/3");
});

test("simpro: writes are blocked before the network", async () => {
  await assert.rejects(() => callOperation("simpro", "post /api/v1.0/companies/{companyID}/jobs/", { body: { Type: "Service" } }), WriteBlocked);
  await assert.rejects(() => callOperation("simpro", "delete /api/v1.0/companies/{companyID}/schedules/", { body: { IDs: [1] } }), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("simpro: a prepared request cannot name another company in any spelling", async () => {
  const base = "https://acme-electrical.simprosuite.com/api/v1.0/companies/0/jobs/";
  for (const q of ["?CompanyID=5", "?companyid=5", "?companyID=0&company_id=5"])
    await assert.rejects(() => sendPrepared("simpro", { url: base + q, method: "GET", headers: {} } as any), /must be the client's own/, q);
  assert.equal(hits.length, 0);
  await sendPrepared("simpro", { url: base + "?companyID=0", method: "GET", headers: {} } as any);
  assert.equal(hits.length, 1);
});
