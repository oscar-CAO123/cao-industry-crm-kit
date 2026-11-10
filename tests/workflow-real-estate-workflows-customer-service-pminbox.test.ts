// Morning manager email (pminbox) workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, digest, CRONS } from "../industries/real-estate/workflows/customer-service/pminbox/index.ts";

const FOLDER = "industries/real-estate/workflows/customer-service/pminbox";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "manager@example.com.au";
const NOW = new Date("2026-11-09T20:30:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let drafts = 0;

// Unread inbox threads. thr2 was answered last (its last message is SENT). thr3 is a newsletter.
const THREADS: Record<string, any[]> = {
  thr1: [{ id: "m1", labelIds: ["INBOX", "UNREAD"], internalDate: "1762640000000", snippet: "Water is coming through the ceiling, please call",
    payload: { headers: [{ name: "Subject", value: "Burst pipe in the laundry at 4 Test St" }, { name: "From", value: '"Sam Lee" <sam@example.com>' }] } }],
  thr2: [{ id: "m2", labelIds: ["SENT"], internalDate: "1762640000000", snippet: "Thanks", payload: { headers: [{ name: "Subject", value: "Old" }, { name: "From", value: MAILBOX }] } }],
  thr3: [{ id: "m3", labelIds: ["INBOX", "UNREAD"], internalDate: "1762640000000", snippet: "Click to unsubscribe",
    payload: { headers: [{ name: "Subject", value: "Newsletter: spring offers" }, { name: "From", value: "Shop <news@shop.example>" }] } }],
  thr4: [{ id: "m4", labelIds: ["INBOX", "UNREAD"], internalDate: "1762640000000", snippet: "The oven is not working",
    payload: { headers: [{ name: "Subject", value: "Oven repair needed at 2 Test St" }, { name: "From", value: '"Kim Tenant" <kim@example.com>' }] } }],
  thr5: [{ id: "m5", labelIds: ["INBOX", "UNREAD"], internalDate: "1762640000000", snippet: "When can I get the keys?",
    payload: { headers: [{ name: "Subject", value: "Question about the lease" }, { name: "From", value: "Lee <not-an-email>" }] } }],
};

function fake() {
  hits = [];
  drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p === "/gmail/v1/users/me/threads" && m === "GET") return json({ threads: [
        { id: "thr1" }, { id: "thr2" }, { id: "thr3" }, { id: "thr4" }, { id: "thr5" }, { id: "../evil" },
      ] });
      const one = p.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
      if (one && m === "GET") {
        const msgs = THREADS[one[1]];
        return msgs ? json({ id: one[1], messages: msgs }) : new Response("not found", { status: 404 });
      }
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") {
        if (body?.message?.threadId === "thrRefused") return new Response("bad thread", { status: 400 });
        drafts++; return json({ id: `draft-${drafts}`, message: { id: `m-${drafts}` } });
      }
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "m-sent" });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

// Sends are the only calls that reach a person outside the business: a Gmail draft send.
const sends = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts/send");
const creates = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST");
const pending = async (store: MemoryStore) =>
  Object.values(await store.list<Approval>("approvals")).filter((a) => a.workflow === WF.id && a.status === "pending");
/** A Gmail API raw message: the headers, and the decoded plain-text body. */
function parts(raw: string) {
  const msg = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = msg.split("\r\n\r\n");
  return { head, body: Buffer.from(body, "base64").toString("utf8") };
}

const SET: any = {
  business_name: "Example Property", digest_to: MAILBOX,
  triage: [
    { category: "noise", match: ["unsubscribe", "newsletter", "no-reply"] },
    { category: "urgent", match: ["burst", "flood", "gas", "no power", "fire", "emergency", "locked out"] },
    { category: "maintenance", match: ["repair", "leak", "broken", "maintenance", "blocked", "not working"] },
    { category: "owner", match: ["owner", "statement", "approve", "bond"] },
    { category: "tenant", match: ["lease", "inspection", "keys", "rent"] },
  ],
  auto_reply: [{ category: "maintenance", body: "Thanks for your message. We have logged your maintenance request and the team will review it shortly." }],
  signature: "Example Property team",
};

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("the crons are wired by entry name", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["digest", "draft", "intake"]);
});

test("a live operation cannot be drafted and a draft operation cannot be queued", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.drafts.create", summary: "x" }), /not a live operation/);
});

test("intake sorts unread mail, skips the answered thread, noise and bad ids, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 4 });
  const all = await store.list<any>("enquiries");
  assert.equal(Object.keys(all).length, 4);
  assert.equal(all["gmail:thr1"].category, "urgent");
  assert.equal(all["gmail:thr1"].status, "triaged");
  assert.equal(all["gmail:thr3"].status, "skipped");
  assert.equal(all["gmail:thr4"].category, "maintenance");
  assert.equal(all["gmail:thr5"].category, "tenant");
  assert.equal(all["gmail:thr5"].sender.email, undefined, "an invalid address is kept out");
  assert.deepEqual(await intake(ctx), { added: 0 }, "re-runs add nothing");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("draft queues only the approved template reply, never urgent mail, and never twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { queued: 1, needs_person: 2 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const p = await pending(store);
  assert.equal(p.length, 1);
  assert.equal(p[0].acts[0].op, "gmail.users.drafts.send");
  assert.equal(p[0].acts[0].input?.body?.id, "draft-1");
  assert.equal(creates().length, 1);
  assert.equal(creates()[0].body.message.threadId, "thr4");
  const { head, body } = parts(creates()[0].body.message.raw);
  assert.match(head, /To: kim@example\.com/);
  assert.match(body, /We have logged your maintenance request/);
  assert.match(body, /Example Property team/);
  assert.deepEqual(await draft(ctx), { queued: 0, needs_person: 2 });
  assert.equal(creates().length, 1, "re-runs never add a Gmail draft twice");
  assert.equal((await pending(store)).length, 1, "re-runs never queue twice");
});

test("a maintenance mail with no valid sender is left for a person, and the mail after it still queues", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const base = { subject: "Broken tap", preview: "The tap is broken", received: NOW.toISOString(), category: "maintenance", status: "triaged" };
  await store.put("enquiries", "gmail:bad", { ...base, id: "gmail:bad", sender: { name: "Lee" }, ref: { thread_id: "thr9", message_id: "m9" } });
  await store.put("enquiries", "gmail:thr4", { ...base, id: "gmail:thr4", sender: { email: "kim@example.com" }, ref: { thread_id: "thr4", message_id: "m4" } });
  assert.deepEqual(await draft(ctx), { queued: 1, needs_person: 1 });
  assert.equal(creates().length, 1, "no Gmail draft for the mail without an address");
  assert.equal((await pending(store)).length, 1);
});

test("one mail Gmail refuses is counted for a person, and the rest of the run still queues", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  const base = { subject: "Broken tap", preview: "The tap is broken", received: NOW.toISOString(), category: "maintenance", status: "triaged" };
  await store.put("enquiries", "gmail:refused", { ...base, id: "gmail:refused", sender: { email: "sam@example.com" }, ref: { thread_id: "thrRefused", message_id: "mr" } });
  await store.put("enquiries", "gmail:thr4", { ...base, id: "gmail:thr4", sender: { email: "kim@example.com" }, ref: { thread_id: "thr4", message_id: "m4" } });
  assert.deepEqual(await draft(ctx), { queued: 1, needs_person: 1 });
  assert.equal((await pending(store)).length, 1);
});

test("the run log never carries a customer's address from a reply draft", async () => {
  const lines: string[] = [];
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, (m) => lines.push(m));
  await intake(ctx); await draft(ctx);
  const draftLines = lines.filter((l) => l.startsWith("draft "));
  assert.ok(draftLines.length > 0);
  assert.ok(draftLines.every((l) => !l.includes("kim@example.com")), draftLines.join("\n"));
});

test("an approved reply sends once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const [q] = await pending(store);
  const ap = await approve(WF, store, q.id, "manager", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].body, { id: "draft-1" });
  await assert.rejects(approve(WF, store, q.id, "manager"), /already done/);
});

test("the morning summary is one draft, urgent first, leaves out noise, and is not repeated", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await digest(ctx), { drafted: 1, items: 3, draft_id: "draft-1" });
  const summary = creates().find((h) => !h.body.message.threadId)!;
  const { head, body } = parts(summary.body.message.raw);
  assert.match(head, /To: manager@example\.com\.au/);
  assert.ok(head.includes(Buffer.from("Morning mail: 1 urgent, 1 maintenance, 1 tenant").toString("base64")), "subject counts the items");
  assert.ok(body.indexOf("[Urgent]") < body.indexOf("[Maintenance]") && body.indexOf("[Maintenance]") < body.indexOf("[Tenant]"), "urgent first");
  assert.match(body, /\(no valid address\)/);
  assert.doesNotMatch(body, /Newsletter/, "noise is left out");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.deepEqual(await digest(ctx), { drafted: 0, items: 0 }, "items are summarised once");
  assert.equal(creates().filter((h) => !h.body.message.threadId).length, 1);
});

test("digest refuses an invalid address and sends nothing", async () => {
  const ctx = context(WF, { ...SET, digest_to: "not-an-address" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(digest(ctx), /not a valid address/);
  assert.equal(sends().length, 0);
});
