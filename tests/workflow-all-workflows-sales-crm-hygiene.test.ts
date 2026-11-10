// CRM hygiene workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { scan, queue } from "../industries/all/workflows/sales/crm-hygiene/index.ts";
import { checkSettings } from "../industries/all/workflows/sales/crm-hygiene/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/crm-hygiene/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let hsContacts: { id: string; email: string; createdAt: string }[] = [];
let pdPages: Record<string, any> = {};     // Pipedrive person list pages, keyed by cursor ("" is the first page)
let pdPersons: Record<string, any> = {};   // Pipedrive persons by id

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // HubSpot: two contacts per search page
      if (p === "/crm/v3/objects/contacts/search" && m === "POST") {
        const off = Number(body?.after ?? 0), rows = hsContacts.slice(off, off + 2);
        const more = off + 2 < hsContacts.length ? { paging: { next: { after: String(off + 2) } } } : {};
        return json({ results: rows.map((c) => ({ id: c.id, properties: { email: c.email }, createdAt: c.createdAt })), total: hsContacts.length, ...more });
      }
      const hg = /^\/crm\/v3\/objects\/contacts\/([0-9]+)$/.exec(p);
      if (hg && m === "GET") {
        const c = hsContacts.find((x) => x.id === hg[1]);
        return c ? json({ id: c.id, properties: { email: c.email } }) : new Response("missing", { status: 404 });
      }
      if ((p === "/crm/v3/objects/contacts/merge" || p === "/crm/v3/objects/contacts/batch/update") && m === "POST") return json({});
      // Pipedrive v2
      if (p === "/api/v2/persons" && m === "GET") return json(pdPages[u.searchParams.get("cursor") ?? ""] ?? { success: true, data: [] });
      const pg = /^\/api\/v2\/persons\/([0-9]+)$/.exec(p);
      if (pg && m === "GET") {
        const x = pdPersons[pg[1]];
        return x ? json({ success: true, data: x }) : new Response("missing", { status: 404 });
      }
      if (pg && m === "PATCH") return json({ success: true, data: { id: Number(pg[1]) } });
      // Pipedrive v1 merge
      if (/^\/v1\/persons\/[0-9]+\/merge$/.test(p) && m === "PUT") return json({ success: true, data: {} });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const HS: any = { crm: "hubspot", read_limit: 1000, fix_email_case: true };
const PD: any = { crm: "pipedrive", read_limit: 1000, fix_email_case: true };
const ctxFor = (s: any, store: MemoryStore, now = NOW) => context(WF, s, store, now, () => {});
const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
/** Anything sent to the CRM that is not a read: a merge, an update, a delete. */
const writes = () => hits.filter((h) => h.method !== "GET" && !(h.method === "POST" && h.path.endsWith("/search")));

beforeEach(() => {
  fake();
  hsContacts = [
    { id: "101", email: "Ann@Example.com", createdAt: "2024-01-01T00:00:00Z" },
    { id: "102", email: "ann@example.com", createdAt: "2024-06-01T00:00:00Z" },   // same address as 101: a duplicate
    { id: "103", email: " Bob@Example.COM ", createdAt: "2024-03-01T00:00:00Z" },  // valid once trimmed and lowercased
    { id: "104", email: "not-an-email", createdAt: "2024-04-01T00:00:00Z" },       // not a valid address: left alone
    { id: "105", email: "carol@example.com", createdAt: "2024-05-01T00:00:00Z" },
  ];
  pdPages = {
    "": { success: true, data: [
      { id: 1, emails: [{ value: "Dana@Shop.com", primary: true }], add_time: "2024-01-01 09:00:00" },
      { id: 2, emails: [{ value: "dana@shop.com", primary: false }], add_time: "2024-05-01 09:00:00" },
    ], additional_data: { next_cursor: "c2" } },
    c2: { success: true, data: [
      { id: 3, emails: [{ value: "eve@shop.com" }], add_time: "2024-06-01 09:00:00" },
    ], additional_data: { next_cursor: null } },
  };
  pdPersons = { "1": { id: 1, emails: [{ value: "Dana@Shop.com", primary: true }] }, "2": { id: 2, emails: [{ value: "dana@shop.com" }] } };
  Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "hs-test", PIPEDRIVE_API_TOKEN: "pd-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a merge on its own, and cannot queue a read", async () => {
  const ctx = ctxFor(HS, new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "hubspot", op: "crm-contacts-3.post-/crm/v3/objects/contacts/merge_merge", summary: "x", input: { body: {} } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "hubspot", op: "crm-contacts-3.post-/crm/v3/objects/contacts/search_doSearch", key: "k", summary: "x", input: {} }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("hubspot: scan reads every page, drafts the register, and writes nothing to the CRM", async () => {
  const store = new MemoryStore();
  const r = await scan(ctxFor(HS, store));
  assert.equal(r.read, 5);
  assert.equal(hits.filter((h) => h.path === "/crm/v3/objects/contacts/search").length, 3, "three pages read");
  const keys = Object.values(await store.list<any>("findings")).map((f) => f.key).sort();
  assert.deepEqual(keys, ["dup:hubspot:102:101", "tidy:hubspot:101", "tidy:hubspot:103"]);
  assert.equal(writes().length, 0, "a scan never writes");
});

test("hubspot: queue makes one pending approval per item, and the oldest contact is the one kept", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(HS, store));
  await queue(ctxFor(HS, store));
  assert.equal(writes().length, 0, "a cron never merges or updates");
  const aps = await approvals(store);
  assert.equal(aps.length, 3);
  assert.ok(aps.every((a) => a.status === "pending"));
  const merge = aps.find((a) => a.acts[0].op.endsWith("merge_merge"))!;
  assert.deepEqual(merge.acts[0].input, { body: { primaryObjectId: "101", objectIdToMerge: "102" } });
  const tidies = aps.filter((a) => a.acts[0].op.endsWith("batch/update_update"));
  assert.deepEqual(tidies.map((t) => t.acts[0].input.body.inputs[0].properties.email).sort(), ["ann@example.com", "bob@example.com"]);
});

test("re-runs never double-queue: a second scan and queue add nothing", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(HS, store)); await queue(ctxFor(HS, store));
  await scan(ctxFor(HS, store)); await queue(ctxFor(HS, store));
  assert.equal((await approvals(store)).length, 3);
  assert.ok(Object.values(await store.list<any>("findings")).every((f) => f.status === "queued"));
});

test("a merge whose record holds capitals or spaces still passes its own live check (the check compares the address exactly as HubSpot holds it)", async () => {
  hsContacts = [
    { id: "101", email: "ann@example.com", createdAt: "2024-01-01T00:00:00Z" },
    { id: "102", email: " Ann@Example.com ", createdAt: "2024-06-01T00:00:00Z" },
  ];
  const store = new MemoryStore();
  await scan(ctxFor(HS, store)); await queue(ctxFor(HS, store));
  const merge = (await approvals(store)).find((a) => a.acts[0].op.endsWith("merge_merge"))!;
  assert.equal(merge.acts[0].check?.expect[0].equals, " Ann@Example.com ", "the expected value is the raw address");
  assert.equal((await approve(WF, store, merge.id, "owner", NOW)).status, "done");
  hsContacts[1].email = "someone-else@example.com";   // the record changed after queueing
  const second = new MemoryStore();
  hsContacts[1].email = " Ann@Example.com ";
  await scan(ctxFor(HS, second)); await queue(ctxFor(HS, second));
  const again = (await approvals(second)).find((a) => a.acts[0].op.endsWith("merge_merge"))!;
  hsContacts[1].email = "someone-else@example.com";
  const r = await approve(WF, second, again.id, "owner", NOW);
  assert.equal(r.status, "rejected", "a merge never runs once the address is gone");
  assert.equal(hits.filter((h) => h.path === "/crm/v3/objects/contacts/merge").length, 1, "only the first merge was sent");
});

test("approving the merge runs it; the tidies wait for their own approval", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(HS, store)); await queue(ctxFor(HS, store));
  const merge = (await approvals(store)).find((a) => a.acts[0].op.endsWith("merge_merge"))!;
  const done = await approve(WF, store, merge.id, "owner", NOW);
  assert.equal(done.status, "done");
  const sent = hits.find((h) => h.method === "POST" && h.path === "/crm/v3/objects/contacts/merge");
  assert.deepEqual(sent?.body, { primaryObjectId: "101", objectIdToMerge: "102" });
  assert.equal(hits.filter((h) => h.path.endsWith("/batch/update")).length, 0, "no tidy runs until approved");
});

test("a cut-short read resolves nothing; a full read resolves a duplicate that no longer matches", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(HS, store));
  hsContacts = hsContacts.map((c) => (c.id === "102" ? { ...c, email: "ann2@example.com" } : c));
  const cut = await scan(ctxFor({ ...HS, read_limit: 2 }, store));
  assert.equal(cut.truncated, true);
  assert.equal((await store.get<any>("findings", "dup:hubspot:102:101"))?.status, "open");
  const full = await scan(ctxFor(HS, store));
  assert.equal(full.truncated, false);
  assert.equal((await store.get<any>("findings", "dup:hubspot:102:101"))?.status, "resolved");
});

test("with fix_email_case off, only the duplicate is queued", async () => {
  const store = new MemoryStore();
  const s = { ...HS, fix_email_case: false };
  await scan(ctxFor(s, store)); await queue(ctxFor(s, store));
  const aps = await approvals(store);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, "crm-contacts-3.post-/crm/v3/objects/contacts/merge_merge");
});

test("pipedrive: pages follow the cursor, the oldest person is kept, and the tidy re-reads the person", async () => {
  const store = new MemoryStore();
  const r = await scan(ctxFor(PD, store));
  assert.equal(r.read, 3);
  await queue(ctxFor(PD, store));
  assert.equal(writes().length, 0, "a cron never merges or updates");
  const aps = await approvals(store);
  const merge = aps.find((a) => a.acts[0].op === "docs_api_v1.mergePersons")!;
  assert.deepEqual(merge.acts[0].input, { params: { id: 2 }, body: { merge_with_id: 1 } });
  const tidy = aps.find((a) => a.acts[0].op === "openapi-v2.updatePerson")!;
  assert.deepEqual(tidy.acts[0].input, { params: { id: 1 }, body: { emails: [{ value: "dana@shop.com", primary: true }] } });
  await approve(WF, store, merge.id, "owner", NOW);
  const sent = hits.find((h) => h.method === "PUT");
  assert.equal(sent?.path, "/v1/persons/2/merge");
  assert.deepEqual(sent?.body, { merge_with_id: 1 });
});

test("a duplicate that no longer shares an address when queued is dropped, never queued as a merge", async () => {
  const store = new MemoryStore();
  await scan(ctxFor(HS, store));                                   // the scan saw 101 and 102 share an address
  hsContacts = hsContacts.map((c) => (c.id === "102" ? { ...c, email: "ann2@example.com" } : c));
  await queue(ctxFor(HS, store));                                  // the records have since changed
  const aps = await approvals(store);
  assert.equal(aps.filter((a) => a.acts[0].op.endsWith("merge_merge")).length, 0, "no merge is queued");
  assert.equal(aps.length, 2, "only the two email tidies are queued");
  assert.equal((await store.get<any>("findings", "dup:hubspot:102:101"))?.status, "resolved");
});

test("pipedrive: an id longer than 15 digits is never read, so no merge can reach another person", async () => {
  pdPages.c2.data.push({ id: "12345678901234567890", emails: [{ value: "dana@shop.com" }], add_time: "2024-02-01 09:00:00" });
  const store = new MemoryStore();
  const r = await scan(ctxFor(PD, store));
  assert.equal(r.read, 3, "the long id is not read");
  await queue(ctxFor(PD, store));
  const merges = (await approvals(store)).filter((a) => a.acts[0].op === "docs_api_v1.mergePersons");
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].acts[0].input, { params: { id: 2 }, body: { merge_with_id: 1 } });
});

test("settings that cannot run are refused before any call", () => {
  assert.throws(() => checkSettings({ ...HS, crm: "salesforce" }), /unknown crm/);
  assert.throws(() => checkSettings({ ...HS, read_limit: 0 }), /read_limit/);
  assert.throws(() => checkSettings({ ...HS, fix_email_case: "yes" }), /fix_email_case/);
  assert.equal(hits.length, 0);
});
