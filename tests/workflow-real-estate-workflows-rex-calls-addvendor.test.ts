// Calls and vendor report workflows, Rex side. Every request goes to a fake network: no test reaches a real Rex or Microsoft account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { callSync, callDraft } from "../industries/real-estate/workflows/sales/calls/index.ts";
import { pull, draft } from "../industries/real-estate/workflows/customer-success/add-vendor/index.ts";

const load = (d: string) => JSON.parse(fs.readFileSync(`industries/real-estate/workflows/${d}/workflow.json`, "utf8")) as WorkflowRecord;
const CALLS = load("sales/calls"), VENDOR = load("customer-success/add-vendor");
const OPS = new Set((JSON.parse(fs.readFileSync("core/sdk/platforms/rex/ops.json", "utf8")) as { id: string }[]).map((o) => o.id));
const NOW = new Date("2026-11-09T01:00:00Z");

type Hit = { method: string; host: string; path: string; body: any };
let hits: Hit[] = [];
let contactRows: any[] = [], listing: any;

beforeEach(() => {
  hits = [];
  contactRows = [{ id: "6", name: "Will Wyman", email_address: "w@example.com", system_modtime: "1557818752", system_record_state: "active" }, { id: "7", name: "No Mail", system_record_state: "active" }];
  listing = { result: { price_advertise_as: "Contact Agent", property: { system_search_key: "2 / 265 Roberts Road, Daglish WA 6008" }, related: {
    listing_adverts: [{ advert_type: "brochure", advert_heading: "Brochure" }, { advert_type: "internet", advert_heading: "Sample Listing" }],
    listing_events: [{ id: 1, event_type: "open_home", event_date: "2026-11-07", event_time: "09:30:00", event_duration_minutes: "30" }, { id: 2, event_type: "auction", event_date: "2026-11-08", event_time: "10:00:00", event_duration_minutes: "30" },
      { id: 3, event_type: "open_home", event_date: "2026-11-30", event_time: "09:30:00", event_duration_minutes: "30" }, { id: 4, event_type: "open_home", event_date: "2026-10-01", event_time: "09:30:00", event_duration_minutes: "30" },
      { id: 5, event_type: "open_home", event_date: "2026-11-02", event_time: "09:30:00", event_duration_minutes: "30" }, { id: 6, event_type: "open_home", event_date: "2026-11-03", event_time: "23:45:00", event_duration_minutes: "30" }] } }, error: null };
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    const u = new URL(String(url)); let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    hits.push({ method: init?.method ?? "GET", host: u.hostname, path: u.pathname, body });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.hostname === "api.rexsoftware.com") {
      if (u.pathname === "/v1/rex/contacts/search") return json({ result: { rows: (body?.offset ?? 0) === 0 ? contactRows : [], total: 2 }, error: null });
      if (u.pathname === "/v1/rex/listings/read") return json(listing);
    }
    if (u.hostname === "graph.microsoft.com" && u.pathname.endsWith("/messages") && init?.method === "POST") return json({ id: "AAMk-draft-1" }, 201);
    return new Response("not faked: " + u.hostname + u.pathname, { status: 404 });
  }) as any });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { REX_ACCESS_TOKEN: "rex-token", M365_ACCESS_TOKEN: "m365-token", KIT_ALLOW_WRITES: "1" });
});

test("every Rex draft op is a mapped operation", () => {
  for (const w of [CALLS, VENDOR]) for (const op of w.draft_ops.rex) assert.ok(OPS.has(op), `${op} is mapped`);
});

test("calls on Rex: contacts come from Rex, a contact with no email is kept without one, nothing is written to Rex", async () => {
  const store = new MemoryStore(), ctx = context(CALLS, { platform: "rex" } as any, store, NOW, () => {});
  assert.deepEqual(await callSync(ctx), { seen: 2, added: 2, updated: 0 });
  const a = (await store.get<any>("call-leads", "6")) as any;
  assert.equal(a.name, "Will Wyman"); assert.equal(a.email, "w@example.com"); assert.equal(a.status, "new");
  assert.equal(((await store.get<any>("call-leads", "7")) as any).email, undefined);
  assert.ok(hits.every((h) => h.host === "api.rexsoftware.com" && /\/search$/.test(h.path)));
  assert.deepEqual(await callSync(ctx), { seen: 2, added: 0, updated: 0 });
});

test("calls on Rex: a contact marked to-contact gets an Outlook draft and a queued send; nothing is sent", async () => {
  const store = new MemoryStore(), S: any = { platform: "rex", business_name: "Acme Realty", microsoft_365: { mailbox: "agent@acme.example.com" } };
  const ctx = context(CALLS, S, store, NOW, () => {});
  await callSync(ctx);
  const l = (await store.get<any>("call-leads", "6")) as any; await store.put("call-leads", "6", { ...l, status: "to-contact" });
  assert.deepEqual(await callDraft(ctx), { queued: 1, no_email: 0 });
  assert.ok(!hits.some((h) => /\/send$/.test(h.path)), "the send waits for approval");
});

test("calls: a bad platform is refused before any call", async () => {
  await assert.rejects(callSync(context(CALLS, { platform: "x" } as any, new MemoryStore(), NOW, () => {})), /platform must be agentbox or rex/);
  assert.equal(hits.length, 0);
});

test("vendor report on Rex: pull reads the listing record only, taking the internet advert heading, the address and the price", async () => {
  const store = new MemoryStore(), S: any = { platform: "rex", vendors: [{ property_id: 1, name: "Will", email: "will@example.com" }], microsoft_365: { mailbox: "agent@acme.example.com" } };
  assert.deepEqual(await pull(context(VENDOR, S, store, NOW, () => {})), { read: 1 });
  const f = (await store.get<any>("properties", "1")) as any;
  assert.equal(f.heading, "Sample Listing"); assert.equal(f.address, "2 / 265 Roberts Road, Daglish WA 6008"); assert.equal(f.price, "Contact Agent"); assert.equal(f.open_homes_known, true);
  assert.deepEqual(f.open_homes, [{ id: 1, start: "2026-11-07 09:30", end: "2026-11-07 10:00" }, { id: 6, start: "2026-11-03 23:45", end: "" }], "exactly 7 dates (3 to 9 Nov): not the auction, a future date, an old one or the 8th day back; an end past midnight is blank");
  assert.deepEqual(hits.map((h) => h.path), ["/v1/rex/listings/read"]); assert.equal(hits[0].body.id, 1);
});

test("vendor report on Rex: the drafted email lists the open home, and the send is queued, not sent", async () => {
  const store = new MemoryStore(), S: any = { platform: "rex", business_name: "Acme", vendors: [{ property_id: 1, name: "Will", email: "will@example.com" }], microsoft_365: { mailbox: "agent@acme.example.com" } };
  const ctx = context(VENDOR, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "1", { text: "A good week.", written: NOW.toISOString() });
  assert.deepEqual(await draft(ctx), { drafted: 1, waiting: 0 });
  const mail = hits.find((h) => h.host === "graph.microsoft.com")!;
  const html = String(mail.body.body.content);
  assert.match(html, /Sample Listing/); assert.match(html, /Open homes in the last 7 days: 2/); assert.match(html, /2026-11-07 09:30 to 2026-11-07 10:00/);
  assert.ok(!hits.some((h) => /\/send$/.test(h.path)));
  const pending = Object.values(await store.list<any>("approvals"));
  assert.equal(pending.length, 1); assert.match(pending[0].summary, /2 open homes in the window/);
});

test("vendor report on Rex: an error reply, a non-record reply and a bad listing id refuse the read; a bad platform is refused", async () => {
  const store = new MemoryStore(), S: any = { platform: "rex", vendors: [{ property_id: 1, email: "will@example.com" }], microsoft_365: { mailbox: "a@b.example.com" } };
  const ctx = context(VENDOR, S, store, NOW, () => {});
  listing = { result: null, error: { message: "x" } }; await assert.rejects(pull(ctx), /returned an error/);
  listing = { result: null, error: null }; await assert.rejects(pull(ctx), /did not come back as a record/);
  await assert.rejects(pull(context(VENDOR, { ...S, vendors: [{ property_id: -1, email: "a@b.example.com" }] }, store, NOW, () => {})), /bad listing id/);
  await assert.rejects(pull(context(VENDOR, { ...S, platform: "x" }, store, NOW, () => {})), /platform must be vaultre or rex/);
});

test("vendor report on Rex: a reply with no events list says nothing about open homes, true or false", async () => {
  const store = new MemoryStore(), S: any = { platform: "rex", vendors: [{ property_id: 1, name: "Will", email: "will@example.com" }], microsoft_365: { mailbox: "agent@acme.example.com" } };
  delete listing.result.related.listing_events;
  const ctx = context(VENDOR, S, store, NOW, () => {});
  await pull(ctx); await store.put("commentary", "1", { text: "A good week.", written: NOW.toISOString() });
  await draft(ctx);
  const html = String(hits.find((h) => h.host === "graph.microsoft.com")!.body.body.content);
  assert.ok(!/open homes/i.test(html), "no claim about open homes");
  assert.match(Object.values(await store.list<any>("approvals"))[0].summary, /open homes not read/);
});
