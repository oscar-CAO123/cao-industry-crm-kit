// Listing syndication tests. Every request goes to a fake network: no test reaches a real VaultRE account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { prepare, enquiries } from "../industries/real-estate/workflows/marketing/listing-syndication/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/marketing/listing-syndication/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { family: "single-entry-syndication", business_name: "Test PM" };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/properties/residential/lease/available"))
        return json({ items: [{ id: 101, displayAddress: "4/12 Test St, Bondi NSW 2026", displayPrice: "$650 per week", heading: "Bright two bedroom", description: "Sunny apartment.", bed: 2, bath: 1, garages: 1, available: true }], totalItems: 1, totalPages: 1 });
      if (p.endsWith("/properties/101/photos"))
        return json({ items: [{ type: "Photograph", published: true }, { type: "Photograph", published: false }, { type: "Floorplan", published: true }], totalItems: 3, totalPages: 1 });
      if (p.endsWith("/account/propertyPortals"))
        return json({ items: [{ id: 1, code: "domain", description: "Domain" }, { id: 2, code: "rea", description: "realestate.com.au" }], totalItems: 2, totalPages: 1 });
      if (p.endsWith("/enquiries"))
        return json({ items: [{ id: 9001, subject: "Enquiry about 4/12 Test St", body: "Is it pet friendly?", processed: false, contactId: 555, personEmails: ["ari@example.com"], personName: "Ari", leaseLifeId: 77, source: "domain" },
          { id: 9002, subject: "Enquiry, no contact", body: "Inspection times?", processed: false, personEmails: ["x@example.com"] }], totalItems: 2, totalPages: 1 });
      if (p.endsWith("/properties/101/notes") && m === "POST") return json({ id: 1 });
      if (p.endsWith("/contacts/555/notes") && m === "POST") return json({ id: 2 });
      if (p.endsWith("/contacts/555/email") && m === "POST") return json({});
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/email"));
const notes = (suffix: string) => hits.filter((h) => h.method === "POST" && h.path.endsWith(suffix));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "vt-test", VAULTRE_API_KEY: "vk-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run the reply operation as a draft, or queue a note as live", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "vaultre", op: "sendContactEmail", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "addPropertyNote", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("prepare: one internal note per vacant rental, never twice, nothing sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await prepare(ctx), { drafted: 1, skipped: 0 });
  const [n] = notes("/properties/101/notes");
  assert.ok(n, "a property note was added");
  assert.match(n.body.body, /LISTING DRAFT, for a person to check\. Not live\./);
  assert.match(n.body.body, /Photos: 2 photographs, 1 floor plans, 2 published/);
  assert.match(n.body.body, /Portals connected to this account: Domain, realestate\.com\.au/);
  assert.equal(sends().length, 0, "nothing sent");
  assert.deepEqual(await prepare(ctx), { drafted: 0, skipped: 1 });
  assert.equal(notes("/properties/101/notes").length, 1, "re-runs never add a second note");
});

test("enquiries: a note on the contact, a stored reply queued once, sent only on approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await enquiries(ctx), { noted: 1, queued: 0, flagged: 1 });
  assert.equal(notes("/contacts/555/notes").length, 1, "the enquiry is noted on its contact");
  assert.equal(sends().length, 0);

  await store.put("replies", "9001", { subject: "Re: 4/12 Test St", text: "Hi Ari, yes, pets are considered case by case. Happy to talk it through." });
  await enquiries(ctx);
  await enquiries(ctx);
  assert.equal(notes("/contacts/555/notes").length, 1, "re-runs never note twice");
  assert.equal(sends().length, 0, "a queued reply is not sent by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "re-runs never queue the reply twice");
  assert.equal(pending[0].status, "pending");

  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "sent once, after approval");
  assert.equal(sends()[0].body.to, "ari@example.com");
  assert.equal(sends()[0].body.subject, "Re: 4/12 Test St");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("enquiries: a reply is never queued for an enquiry with no contact or no valid address", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put("replies", "9002", { subject: "Re: inspections", text: "Inspections are Saturdays at 10." });
  await enquiries(ctx);
  assert.equal((await store.get<any>("enquiries", "9002")).status, "no-contact");
  assert.equal(Object.keys(await store.list("approvals")).length, 0, "nothing queued without a contact");
  assert.equal(sends().length, 0);
});
