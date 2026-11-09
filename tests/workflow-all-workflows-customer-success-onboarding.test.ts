// Onboarding workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { describe as describeOp } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { setup, welcome, progress, CRONS } from "../industries/all/workflows/customer-success/onboarding/index.ts";
import { INVITE } from "../industries/all/workflows/customer-success/onboarding/adapters/hubspot.ts";

const FOLDER = "industries/all/workflows/customer-success/onboarding/";
const WF = JSON.parse(fs.readFileSync(FOLDER + "workflow.json", "utf8")) as WorkflowRecord;
const MAILBOX = "owner@example.com.au";
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: any = {
  business_name: "Test Agency", owner_email: MAILBOX,
  checklist: ["Confirm the signed agreement", "Collect the details form", "Open accounts", "Record the client in the CRM"],
  clients: [{ id: "example-plumbing", name: "Sam Lee", company: "Example Plumbing Pty Ltd", email: "sam@example-plumbing.com.au",
    invite: [{ email: "team@example-plumbing.com.au", firstName: "Alex", roleId: "ROLE1", primaryTeamId: "TEAM1" }] }],
};

type Hit = { method: string; path: string; host: string; body: any };
let hits: Hit[] = [];
let taskItems: { status: string }[] = [];
let n = 0, d = 0;

function fake() {
  hits = []; taskItems = []; n = 0; d = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, host: u.host, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      // Google Workspace
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: `draft-${++d}` });
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "msg-1" });
      if (p === "/tasks/v1/users/@me/lists" && m === "POST") return json({ id: "list-1" });
      if (p === "/tasks/v1/lists/list-1/tasks" && m === "POST") return json({ id: `task-${++n}` });
      if (p === "/tasks/v1/lists/list-1/tasks" && m === "GET") return json({ items: taskItems });
      // HubSpot
      if (p === "/crm/objects/2026-09/contacts" && m === "POST") return json({ id: "501" });
      if (p === "/commerce/payment-accounts/2026-09/status") return json({});
      if (p === "/settings/users/2026-09" && m === "POST") return json({ id: "u-1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

/** Every write that reaches a client or an invitee. A cron must never produce one of these. */
const sends = () => hits.filter((h) => h.method === "POST" && (/\/drafts\/send$/.test(h.path) || h.path === "/settings/users/2026-09"));
const approvalsOf = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const onlyRecord = async (store: MemoryStore) => Object.values(await store.list<any>("onboarding"))[0];

beforeEach(async () => {
  fake(); setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", HUBSPOT_ACCESS_TOKEN: "h_test", KIT_ALLOW_WRITES: "1" });
});

test("the record, the crons and the operations agree; each operation is mapped and sits in one list only", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  for (const lists of [WF.draft_ops, WF.live_ops]) for (const [p, ids] of Object.entries(lists)) for (const id of ids) describeOp(p, id);
  for (const [p, ids] of Object.entries(WF.live_ops)) for (const id of ids) assert.equal((WF.draft_ops[p] ?? []).includes(id), false);
});

test("a draft operation cannot be a live one, and a live one cannot run as a draft", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "hubspot", op: INVITE, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "tasks.tasks.insert", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("setup creates the contact and the checklist and queues the invitation; a cron sends nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await setup(ctx), { set_up: 1, invitations: 1 });
  const contact = hits.find((h) => h.path === "/crm/objects/2026-09/contacts");
  assert.equal(contact?.body.properties.company, "Example Plumbing Pty Ltd");
  assert.deepEqual(contact?.body.associations, []);
  assert.equal(hits.filter((h) => h.path === "/tasks/v1/lists/list-1/tasks" && h.method === "POST").length, 4);
  assert.equal(sends().length, 0, "nothing sent or invited by a cron");
  const aps = await approvalsOf(store);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, INVITE);
  assert.equal(aps[0].status, "pending");
  assert.equal((await onlyRecord(store)).stage, "set-up");
});

test("re-running setup adds no second contact, checklist or invitation", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  const before = hits.length;
  assert.deepEqual(await setup(ctx), { set_up: 0, invitations: 1 });
  assert.equal(hits.filter((h) => h.path === "/crm/objects/2026-09/contacts").length, 1);
  assert.equal(hits.filter((h) => h.path === "/tasks/v1/lists/list-1/tasks" && h.method === "POST").length, 4);
  assert.equal((await approvalsOf(store)).length, 1);
  assert.equal(hits.slice(before).filter((h) => h.method === "POST").length, 0, "no writes on the second run");
});

test("welcome drafts the email and queues its send; only an approval sends it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  assert.deepEqual(await welcome(ctx), { drafted: 1, queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const drafts = hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST");
  assert.equal(drafts.length, 1);
  const raw = Buffer.from(drafts[0].body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: sam@example-plumbing\.com\.au/m);
  assert.deepEqual(await welcome(ctx), { drafted: 0, queued: 0 }, "re-runs queue nothing new");
  const aps = await approvalsOf(store);
  assert.equal(aps.length, 2);
  const send = aps.find((a) => a.acts[0].op === "gmail.users.drafts.send")!;
  const done = await approve(WF, store, send.id, "oscar", NOW);
  assert.equal(done.status, "done");
  const sent = hits.find((h) => h.path === "/gmail/v1/users/me/drafts/send");
  assert.equal(sent?.body.id, "draft-1", "the approval sends the draft that was checked");
});

test("approving the invitation calls HubSpot with the invitee and the welcome flag", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  const inv = (await approvalsOf(store)).find((a) => a.acts[0].op === INVITE)!;
  assert.equal((await approve(WF, store, inv.id, "oscar", NOW)).status, "done");
  const call = hits.find((h) => h.path === "/settings/users/2026-09")!;
  assert.equal(call.body.email, "team@example-plumbing.com.au");
  assert.equal(call.body.sendWelcomeEmail, true);
  assert.equal(call.body.roleId, "ROLE1");
});

test("a header injected through the welcome subject cannot add a header", async () => {
  const store = new MemoryStore();
  const bad = { ...SETTINGS, welcome: { subject: "Hi\r\nBcc: someone@example.org", body: "Hi {name}" } };
  const ctx = context(WF, bad, store, NOW, () => {});
  await setup(ctx);
  await welcome(ctx);
  const raw = Buffer.from(hits.find((h) => h.path === "/gmail/v1/users/me/drafts")!.body.message.raw, "base64url").toString("utf8");
  assert.doesNotMatch(raw, /^Bcc:/m);
});

test("progress reads the checklist, notes the owner once per change, and marks the client complete", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await setup(ctx);
  await welcome(ctx);
  taskItems = [{ status: "completed" }, { status: "needsAction" }, { status: "needsAction" }, { status: "needsAction" }];
  assert.deepEqual(await progress(ctx), { noted: 1 });
  assert.deepEqual(await progress(ctx), { noted: 0 }, "same open count, no second note");
  assert.equal(sends().length, 0);
  taskItems = taskItems.map(() => ({ status: "completed" }));
  assert.deepEqual(await progress(ctx), { noted: 1 });
  const rec = await onlyRecord(store);
  assert.equal(rec.stage, "complete");
  assert.equal(rec.progress.open, 0);
});

test("a bad client email stops the run before any network call", async () => {
  const bad = { ...SETTINGS, clients: [{ id: "x-client", name: "X", email: "not-an-email" }] };
  await assert.rejects(setup(context(WF, bad, new MemoryStore(), NOW, () => {})), /bad email/);
  assert.equal(hits.length, 0);
});

test("a draft is logged against the client id, never the recipient's address", async () => {
  const store = new MemoryStore(), logs: string[] = [], ctx = context(WF, SETTINGS, store, NOW, (m) => logs.push(m));
  await setup(ctx);
  await welcome(ctx);
  const drafts = logs.filter((l) => l.startsWith("draft google-workspace gmail.users.drafts.create"));
  assert.equal(drafts.length, 1);
  assert.match(drafts[0], /example-plumbing/);
  assert.doesNotMatch(drafts[0], /@/, "no address in the draft log line");
  assert.equal(hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST").length, 1);
});
