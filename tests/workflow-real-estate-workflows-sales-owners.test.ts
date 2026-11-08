// Owner contacts workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { ownerList, consentCheck, outreach } from "../industries/real-estate/workflows/sales/owners/index.ts";
import { contactId } from "../industries/real-estate/workflows/sales/owners/adapters/vaultre.ts";
import { mailDraft } from "../industries/real-estate/workflows/sales/owners/adapters/microsoft-365.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/sales/owners/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = {
  business_name: "Test Realty", microsoft_365: { mailbox: "sales@example.com" }, owners_per_run: 25, daily_limit: 20,
  outreach_subject: "Checking in", outreach_body: "Hi {first_name}, this is {business_name}. Reply STOP to be removed.",
};
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let gdprEmail: Record<string, boolean> = {};
let drafts = 0;

const CONTACTS: Record<string, any> = {
  "101": { id: 101, firstName: "Ann", lastName: "Smith", displayName: "<b>Ann</b> Smith", emails: ["ann@example.com"],
           phoneNumbers: [{ number: "0412 000 111", type: "Mobile" }], onDoNotCallList: false, unsubscribe: { email: false } },
  "102": { id: 102, displayName: "Bob Jones", emails: ["bob@example.com"], phoneNumbers: [], onDoNotCallList: false, unsubscribe: { email: false } },
  "103": { id: 103, displayName: "Cy Lane", emails: ["cy@example.com"], onDoNotCallList: true, unsubscribe: { email: false } },
  "104": { id: 104, displayName: "Di Park", emails: ["di@example.com"], onDoNotCallList: false, unsubscribe: { email: true } },
};

function fake() {
  hits = []; drafts = 0;
  gdprEmail = { "101": true, "102": false, "103": true, "104": true };
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // VaultRE
      if (p.endsWith("/contacts/currentOwners")) return json({ items: [
        { contact: { id: 101 } }, { contact: { id: 102 } }, { contact: { id: 103 } }, { contact: { id: 104 } }, { contact: { id: "abc" } },
      ], totalPages: 1 });
      const gd = p.match(/\/contacts\/(\d+)\/gdpr$/);
      if (gd) {
        const id = gd[1];
        const rows = id === "101"
          ? [{ id: 1, email: false, sms: false, phone: false, modified: "2026-01-01T00:00:00Z" }, { id: 2, email: gdprEmail[id], sms: false, phone: false, modified: "2026-10-01T00:00:00Z" }]
          : [{ id: 3, email: gdprEmail[id], sms: false, phone: false, modified: "2026-10-01T00:00:00Z" }];
        return json({ items: rows, totalPages: 1 });
      }
      const c = p.match(/\/contacts\/(\d+)$/);
      if (c && CONTACTS[c[1]]) return json(CONTACTS[c[1]]);
      // Microsoft Graph
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.path.endsWith("/send"));
const drafted = () => hits.filter((h) => /\/messages$/.test(h.path) && h.method === "POST");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "vt", VAULTRE_API_KEY: "vk", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("owner list adds each owner once and drops a malformed row", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await ownerList(ctx), { added: 4 });
  assert.deepEqual(await ownerList(ctx), { added: 0 }, "a second run adds nothing");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("consent check: eligible, no consent, do-not-call and opted-out each get their own status; nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await ownerList(ctx);
  assert.deepEqual(await consentCheck(ctx), { checked: 4, eligible: 1, "no-consent": 1, blocked: 2 });
  const owners = await store.list<any>("owners");
  assert.equal(owners["101"].status, "eligible");
  assert.equal(owners["102"].status, "no-consent");
  assert.equal(owners["103"].status, "blocked");
  assert.equal(owners["104"].status, "blocked");
  assert.equal(drafted().length, 0, "no draft before outreach");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("outreach drafts only the eligible owner, escapes the name, queues one send, and never queues twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await ownerList(ctx); await consentCheck(ctx);
  assert.deepEqual(await outreach(ctx), { queued: 1, stopped: 0 });
  assert.equal(drafted().length, 1, "one draft");
  const d = drafted()[0].body;
  assert.deepEqual(d.toRecipients, [{ emailAddress: { address: "ann@example.com" } }]);
  assert.ok(d.body.content.includes("&lt;b&gt;Ann&lt;/b&gt;"), "name is escaped");
  assert.ok(!d.body.content.includes("<b>"), "no raw markup in the draft");
  assert.equal(sends().length, 0, "queued, not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.deepEqual(await outreach(ctx), { queued: 0, stopped: 0 }, "a second run finds no eligible owner left to queue");
  assert.equal(drafted().length, 1, "no second draft");
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "no second approval");
});

test("approval sends the draft once; a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await ownerList(ctx); await consentCheck(ctx); await outreach(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1, "sent once, on approval");
  assert.match(sends()[0].path, /\/messages\/AAMkDraft1\/send$/);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1);
});

test("consent withdrawn after the check: outreach re-reads it and drafts nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await ownerList(ctx); await consentCheck(ctx);
  gdprEmail["101"] = false;
  assert.deepEqual(await outreach(ctx), { queued: 0, stopped: 1 });
  assert.equal(drafted().length, 0);
  assert.equal((await store.get<any>("owners", "101"))!.status, "no-consent");
});

test("a cron cannot draft a send or queue a draft-only call, and an SMS is never queued by this workflow", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "sendContactSMS", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "vaultre", op: "deleteContact", summary: "x" }), /not a draft operation/);
});

test("bad ids and addresses are refused before they reach a path or a recipient", async () => {
  assert.throws(() => contactId("12;DELETE"), /bad contact id/);
  assert.throws(() => contactId("0"), /bad contact id/);
  assert.equal(contactId("101"), 101);
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(mailDraft(ctx, "not-an-address", "s", "<p>x</p>"), /bad recipient/);
  assert.equal(drafts, 0);
});
