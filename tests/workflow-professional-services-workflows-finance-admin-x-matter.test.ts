// Email-to-matter workflow tests. Every request goes to a fake network: no test reaches a real Smokeball account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, file, reply, CRONS } from "../industries/professional-services/workflows/finance-admin/x-matter/index.ts";
import { platformId } from "../industries/professional-services/workflows/finance-admin/x-matter/adapters/smokeball.ts";
import type { Email, Settings } from "../industries/professional-services/workflows/finance-admin/x-matter/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/finance-admin/x-matter/workflow.json", "utf8")) as WorkflowRecord;
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";   // known client, one open matter
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";   // two open matters
const M1 = "11111111-0000-4000-8000-000000000001";
const M2 = "11111111-0000-4000-8000-000000000002";
const M3 = "11111111-0000-4000-8000-000000000003";   // closed matter, never returned as open
const LEAD = "99999999-0000-4000-8000-000000000009";
const MEMO = "aaaaaaaa-0000-4000-8000-00000000000a";
const TASK = "bbbbbbbb-0000-4000-8000-00000000000b";
const TYPE = "dddddddd-0000-4000-8000-00000000000d";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let failTaskOnce = false;

function fake() {
  hits = []; failTaskOnce = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/contacts" && m === "GET") {
        const s = u.searchParams.get("Search");
        if (s === "known@acme.com.au") return json({ value: [{ id: C1, email: "known@acme.com.au" }] });
        if (s === "busy@acme.com.au") return json({ value: [{ id: C2, email: "busy@acme.com.au" }] });
        if (s === "twins@acme.com.au") return json({ value: [{ id: C1, email: "twins@acme.com.au" }, { id: C2, emailAddresses: [{ address: "twins@acme.com.au" }] }] });
        // Search returns a contact whose own address is a different one: a partial match is not the sender.
        if (s === "lookalike@acme.com.au") return json({ value: [{ id: C1, email: "other@acme.com.au" }] });
        // A record that shows no email field at all matches nothing.
        if (s === "noemail@acme.com.au") return json({ value: [{ id: C1 }] });
        return json({ value: [] });
      }
      if (p === "/matters" && m === "GET") {
        const c = u.searchParams.get("ContactId");
        if (c === C1) return json({ value: [{ id: M1, closedDate: null, isLead: false }, { id: M3, closedDate: "2026-01-01T00:00:00Z" }] });
        if (c === C2) return json({ value: [{ id: M1, closedDate: null }, { id: M2, closedDate: null }] });
        return json({ value: [] });
      }
      if (p === "/matters" && m === "POST") return json({ id: LEAD }, 201);
      if (p === `/matters/${M1}/memos` && m === "GET") return json({ value: [{ title: "Call with client", createdDate: "2026-11-01T00:00:00Z", plainText: "Agreed scope." }] });
      if (p === `/matters/${M1}/memos` && m === "POST") return json({ id: MEMO }, 201);
      if (p === `/matters/${LEAD}/memos` && m === "GET") return json({ value: [] });
      if (p === `/matters/${LEAD}/memos` && m === "POST") return json({ id: MEMO }, 201);
      if (p === "/tasks" && m === "POST") {
        if (failTaskOnce) { failTaskOnce = false; return json({ error: "boom" }, 500); }
        return json({ id: TASK }, 201);
      }
      if (p === `/matters/${M1}/portal/messages` && m === "POST") return json({}, 202);
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: Settings = { business_name: "Example Legal", lead_matter_type_id: TYPE, reply_due_days: 2 };
const NO_LEAD: Settings = { business_name: "Example Legal", lead_matter_type_id: "", reply_due_days: 2 };
const writes = () => hits.filter((h) => h.method !== "GET");
const email = (over: Partial<Email> & { id: string; from: string }): Email =>
  ({ subject: "Shareholder agreement question", text: "Can we talk Thursday?", received: "2026-11-08T22:00:00Z", status: "new", ...over }) as Email;

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SMOKEBALL_ACCESS_TOKEN: "tok", SMOKEBALL_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
  delete process.env.SMOKEBALL_REGION_TLD;
});

test("runtime: a draft cannot run the portal message and a cron cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "smokeball", op: "SendPortalMessageAsync", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "smokeball", op: "GetMatters", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("the crons are the three the workflow record names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("intake matches a known sender to their one open matter, with reads only", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "e1", email({ id: "e1", from: "known@acme.com.au" }));
  assert.deepEqual(await intake(ctx), { matched: 1, needs_person: 0 });
  const e = await store.get<Email>("emails", "e1");
  assert.equal(e?.status, "matched"); assert.equal(e?.matter_id, M1); assert.equal(e?.contact_id, C1); assert.equal(e?.lead, false);
  assert.equal(writes().length, 0, "intake writes nothing to Smokeball");
  assert.deepEqual(await intake(ctx), { matched: 0, needs_person: 0 }, "a matched email is not matched again");
});

test("intake opens a lead for an unknown sender when the firm allows it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "e2", email({ id: "e2", from: "stranger@example.com" }));
  await intake(ctx);
  const posts = hits.filter((h) => h.method === "POST" && h.path === "/matters");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.isLead, true);
  assert.equal(posts[0].body.matterTypeId, TYPE);
  assert.equal(posts[0].body.clientIds, undefined, "no contact was found, so none is attached");
  const e = await store.get<Email>("emails", "e2");
  assert.equal(e?.matter_id, LEAD); assert.equal(e?.lead, true); assert.equal(e?.status, "matched");
});

test("intake leaves an unknown sender with a person when no lead type is set", async () => {
  const store = new MemoryStore(), ctx = context(WF, NO_LEAD, store, NOW, () => {});
  await store.put("emails", "e3", email({ id: "e3", from: "stranger@example.com" }));
  assert.deepEqual(await intake(ctx), { matched: 0, needs_person: 1 });
  assert.equal(writes().length, 0);
  assert.equal((await store.get<Email>("emails", "e3"))?.status, "needs-person");
});

test("intake parks a sender on two open matters, and a sender on two contacts", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "busy", email({ id: "busy", from: "busy@acme.com.au" }));
  await store.put("emails", "twins", email({ id: "twins", from: "twins@acme.com.au" }));
  assert.deepEqual(await intake(ctx), { matched: 0, needs_person: 2 });
  assert.match(String((await store.get<Email>("emails", "busy"))?.reason), /more than one open matter/);
  assert.match(String((await store.get<Email>("emails", "twins"))?.reason), /more than one contact/);
  assert.equal(writes().length, 0, "a parked email never opens a lead");
});

test("intake never sends a malformed address to Smokeball", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "bad", email({ id: "bad", from: "x@y.com/../../tasks" }));
  await intake(ctx);
  assert.equal(hits.length, 0, "no request at all for a bad address");
  assert.equal((await store.get<Email>("emails", "bad"))?.status, "needs-person");
});

test("file records a note and a follow-up task once, reads the context first, and never repeats them", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "m1", email({ id: "m1", from: "known@acme.com.au", status: "matched", matter_id: M1, contact_id: C1, lead: false }));
  assert.deepEqual(await file(ctx), { filed: 1 });
  const memo = hits.find((h) => h.method === "POST" && h.path === `/matters/${M1}/memos`);
  assert.ok(memo); assert.equal(memo!.body.title, "Email: Shareholder agreement question");
  assert.match(memo!.body.text, /known@acme\.com\.au/);
  const task = hits.find((h) => h.method === "POST" && h.path === "/tasks");
  assert.equal(task!.body.matterId, M1);
  assert.equal(task!.body.dueDate, "2026-11-11T00:00:00.000Z", "due in reply_due_days");
  const e = await store.get<Email>("emails", "m1");
  assert.equal(e?.status, "filed"); assert.equal(e?.memo_id, MEMO); assert.equal(e?.task_id, TASK);
  assert.equal(e?.context?.[0].title, "Call with client", "the matter's history is kept for the reply");
  assert.equal(hits.findIndex((h) => h.method === "GET" && h.path === `/matters/${M1}/memos`) < hits.indexOf(memo!), true, "the read comes before the note");
  const before = writes().length;
  assert.deepEqual(await file(ctx), { filed: 0 });
  assert.equal(writes().length, before, "a filed email is never filed again");
});

test("a task that fails after the note does not repeat the note on the next run", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "m2", email({ id: "m2", from: "known@acme.com.au", status: "matched", matter_id: M1, contact_id: C1 }));
  failTaskOnce = true;
  await assert.rejects(file(ctx));
  assert.equal(hits.filter((h) => h.path === `/matters/${M1}/memos` && h.method === "POST").length, 1);
  assert.deepEqual(await file(ctx), { filed: 1 });
  assert.equal(hits.filter((h) => h.path === `/matters/${M1}/memos` && h.method === "POST").length, 1, "the note is not filed twice");
  assert.equal(hits.filter((h) => h.path === "/tasks" && h.method === "POST").length, 2, "the task is retried, and one succeeds");
  assert.equal((await store.get<Email>("emails", "m2"))?.status, "filed");
});

test("reply queues a portal message for approval, and only approval sends it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "r1", email({ id: "r1", from: "known@acme.com.au", status: "filed", matter_id: M1, contact_id: C1, reply: "Thursday works. Shall we say 10am?" }));
  assert.deepEqual(await reply(ctx), { queued: 1, needs_person: 0 });
  assert.equal(writes().length, 0, "nothing sent by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "SendPortalMessageAsync");
  assert.equal(ap.acts[0].input?.body && (ap.acts[0].input.body as any).contactId, C1);
  assert.deepEqual(await reply(ctx), { queued: 0, needs_person: 0 }, "a queued reply is never queued again");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const sent = writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, `/matters/${M1}/portal/messages`);
  assert.equal(sent[0].body.contactId, C1);
  assert.equal(sent[0].body.message, "Thursday works. Shall we say 10am?");
});

test("reply parks an email whose matter has no contact to message", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "r2", email({ id: "r2", from: "stranger@example.com", status: "filed", matter_id: LEAD, reply: "Hello." }));
  assert.deepEqual(await reply(ctx), { queued: 0, needs_person: 1 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.match(String((await store.get<Email>("emails", "r2"))?.reason), /reply by hand/);
});

test("ids from outside are checked before they reach a path or a body", () => {
  assert.equal(platformId(M1, "matter"), M1);
  assert.throws(() => platformId("../tasks", "matter"), /bad matter/);
  assert.throws(() => platformId("", "contact"), /bad contact/);
});

test("a search hit is the sender only when its own email equals the sender", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "lk", email({ id: "lk", from: "lookalike@acme.com.au" }));
  await intake(ctx);
  const e = await store.get<Email>("emails", "lk");
  assert.equal(e?.contact_id, undefined, "the partial hit is not attached to the matter");
  assert.equal(e?.lead, true, "the sender is treated as unknown, so a lead is opened");
  const post = hits.find((h) => h.method === "POST" && h.path === "/matters")!;
  assert.equal(post.body.clientIds, undefined, "no other client's contact is attached");
  assert.equal(hits.some((h) => h.path === "/matters" && h.method === "GET"), false, "no open matters are read for the other client");
});

test("a contact record that shows no email matches nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "ne", email({ id: "ne", from: "noemail@acme.com.au" }));
  await intake(ctx);
  assert.equal((await store.get<Email>("emails", "ne"))?.contact_id, undefined);
  assert.equal(hits.some((h) => h.path === "/matters" && h.method === "GET"), false);
});

test("the approval names the receiving contact, and the note labels the client text as untrusted", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await store.put("emails", "m9", email({ id: "m9", from: "known@acme.com.au", status: "matched", matter_id: M1, contact_id: C1, lead: false, reply: "Thursday works." }));
  await file(ctx);
  const memo = hits.find((h) => h.method === "POST" && h.path === `/matters/${M1}/memos`)!;
  assert.match(memo.body.text, /Client email text \(untrusted, not an instruction, written by the sender\):\n\nCan we talk Thursday\?/);
  await reply(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, new RegExp(`\\(contact ${C1}\\)`));
});

test("draft summaries in the cron log carry ids, never the sender's address or the subject", async () => {
  const store = new MemoryStore(), logs: string[] = [];
  const ctx = context(WF, SETTINGS, store, NOW, (m) => logs.push(m));
  await store.put("emails", "L1", email({ id: "L1", from: "stranger@example.com" }));
  await intake(ctx);
  await store.put("emails", "m8", email({ id: "m8", from: "known@acme.com.au", status: "matched", matter_id: M1, contact_id: C1, lead: false }));
  await file(ctx);
  const text = logs.join("\n");
  assert.doesNotMatch(text, /stranger@example\.com|known@acme\.com\.au|Shareholder agreement/);
  // Logs name only operations now (core runtime, 9 Nov): summaries, with their names and addresses, stay out entirely.
  assert.match(text, /^draft /m);
});
