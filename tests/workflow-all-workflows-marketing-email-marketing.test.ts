// Email marketing workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { describe as opDescribe } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { sync, draft, flows } from "../industries/all/workflows/marketing/email-marketing/index.ts";
import { keyOf } from "../industries/all/workflows/marketing/email-marketing/types.ts";

const DIR = "industries/all/workflows/marketing/email-marketing";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failCreate = 0;

function fake() {
  hits = []; failCreate = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      const none = () => new Response(null, { status: 204 });
      // Mailchimp
      if (p === "/3.0/reports" && m === "GET") return json({ reports: [{ id: "c1", campaign_title: "October", subject_line: "Market update", send_time: "2026-11-01T20:00:00+00:00",
        emails_sent: 500, opens: { open_rate: 0.12 }, clicks: { click_rate: 0.03 } }] });
      if (p === "/3.0/automations" && m === "GET") return json({ automations: [{ id: "wf1", status: "sending", settings: { title: "Welcome" } }] });
      if (p === "/3.0/automations/wf1/emails" && m === "GET") return json({ emails: [{ id: "e1", status: "sending", settings: { subject_line: "Welcome in" } }] });
      if (p === "/3.0/campaigns" && m === "POST") {
        if (failCreate-- > 0) return new Response("{}", { status: 400 });
        return json({ id: "CMP1", status: "save" });
      }
      if (p === "/3.0/campaigns/CMP1/content" && m === "PUT") return json({ html: "<p>Hello</p>" });
      if (p === "/3.0/campaigns/CMP1/actions/schedule" && m === "POST") return none();
      if (p === "/3.0/automations/wf1/emails/e1/actions/start" && m === "POST") return none();
      if (p === "/3.0/automations/wf1/emails/e1/actions/pause" && m === "POST") return none();
      // Klaviyo
      if (p === "/api/flows" && m === "GET") return json({ data: [{ id: "KF1", attributes: { name: "Abandoned cart", status: "live" } }] });
      if (p === "/api/flows/KF1" && m === "PATCH") return json({ data: { type: "flow", id: "KF1", attributes: { status: "live" } } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => /\/actions\/(schedule|send)$/.test(h.path) || /\/actions\/(start|pause)$/.test(h.path) || (h.method === "PATCH" && h.path.startsWith("/api/flows/")));
const creates = () => hits.filter((h) => h.method === "POST" && h.path === "/3.0/campaigns");
const S: any = { family: "newsletter-and-flows", business_name: "Test Realty", platforms: ["mailchimp", "klaviyo"], newsletter: "mailchimp",
  mailchimp: { list_id: "abc123", from_name: "Test Realty", reply_to: "hello@example.com" }, klaviyo: { revision: "2026-10-15" }, targets: { open_rate: 0.2, click_rate: null } };
const NOW = new Date("2026-11-08T00:00:00Z");
const LATER = "2026-11-20T20:00:00Z";
const NEWS = { subject: "November market update", preview_text: "What sold this month", html: "<p>Hello</p>", schedule_time: LATER };
const quiet = () => {};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { MAILCHIMP_API_KEY: "test-mc", MAILCHIMP_DC: "us1", KLAVIYO_API_KEY: "test-kl", KIT_ALLOW_WRITES: "1" });
});

test("every draft and live operation in the record is mapped in the kit", () => {
  for (const list of [WF.draft_ops, WF.live_ops] as Record<string, string[]>[])
    for (const [platform, ops] of Object.entries(list)) for (const op of ops) assert.doesNotThrow(() => opDescribe(platform, op), `${platform} ${op}`);
});

test("runtime: a draft cannot run a live operation, and a cron cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, quiet);
  await assert.rejects(ctx.draft({ platform: "mailchimp", op: "core.campaigns_create-action-schedule", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "klaviyo", op: "update_flow", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "mailchimp", op: "core.campaigns_list", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "nothing reached the network");
});

test("sync reads only: every request is a GET, and the results land in the store", async () => {
  const store = new MemoryStore();
  await sync(context(WF, S, store, NOW, quiet));
  assert.ok(hits.length >= 4);
  assert.deepEqual(hits.filter((h) => h.method !== "GET"), [], "no write from the sync cron");
  assert.equal((await store.get<any>("reports", keyOf("mailchimp:c1")))!.below_target, true, "0.12 is under the 0.2 open target");
  assert.equal((await store.get<any>("flows", keyOf("klaviyo:KF1")))!.status, "live");
});

test("draft: a newsletter becomes a draft campaign and a queued schedule; the cron never schedules it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, quiet);
  await store.put("newsletters", "nov-update", NEWS);
  assert.deepEqual(await draft(ctx), { created: 1, queued: 1, parked: 0 });
  const c = creates()[0];
  assert.equal(c.body.type, "regular");
  assert.equal(c.body.recipients.list_id, "abc123");
  assert.equal(c.body.settings.subject_line, "November market update");
  assert.ok(hits.some((h) => h.method === "PUT" && h.path === "/3.0/campaigns/CMP1/content" && h.body.html === "<p>Hello</p>"));
  assert.equal(sends().length, 0, "nothing scheduled by a cron");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts[0].op, "core.campaigns_create-action-schedule");
  assert.deepEqual(ap.acts[0].input, { params: { campaign_id: "CMP1" }, body: { schedule_time: "2026-11-20T20:00:00+00:00" } });
  assert.match(ap.summary, /Schedule "November market update"/);
});

test("re-runs never create a second campaign or queue a second schedule; approval runs it once", async () => {
  const store = new MemoryStore();
  await store.put("newsletters", "nov-update", NEWS);
  await draft(context(WF, S, store, NOW, quiet));
  assert.deepEqual(await draft(context(WF, S, store, NOW, quiet)), { created: 0, queued: 0, parked: 0 });
  assert.equal(creates().length, 1);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(hits.find((h) => h.path === "/3.0/campaigns/CMP1/actions/schedule")!.body.schedule_time, "2026-11-20T20:00:00+00:00");
  await assert.rejects(approve(WF, store, pending[0].id, "owner", NOW), /already done/);
});

test("a newsletter that fails validation is parked, and nothing reaches the network", async () => {
  const store = new MemoryStore();
  await store.put("newsletters", "two-lines", { ...NEWS, subject: "Line one\nBCC: someone@example.com" });
  await store.put("newsletters", "too-late", { ...NEWS, schedule_time: "2026-11-01T00:00:00Z" });
  assert.deepEqual(await draft(context(WF, S, store, NOW, quiet)), { created: 0, queued: 0, parked: 2 });
  assert.equal(creates().length, 0);
  const row = await store.get<any>("newsletters", "two-lines");
  assert.equal(row.status, "needs-attention");
  assert.match(row.reason, /one line/);
  assert.match((await store.get<any>("newsletters", "too-late"))!.reason, /15 minutes/);
});

test("a create the platform refuses is parked for a person, and is not repeated on the next run", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, quiet);
  await store.put("newsletters", "nov-update", NEWS);
  failCreate = 1;
  assert.deepEqual(await draft(ctx), { created: 0, queued: 0, parked: 1 });
  assert.equal((await store.get<any>("newsletters", "nov-update"))!.status, "needs-attention");
  assert.deepEqual(await draft(context(WF, S, store, NOW, quiet)), { created: 0, queued: 0, parked: 0 });
  assert.equal(creates().length, 1, "one attempt, no repeat");
});

test("flow changes: queued by the cron, run only when a person approves each one", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, quiet);
  await store.put("flow-changes", "wel-start", { platform: "mailchimp", action: "start", workflow_id: "wf1", email_id: "e1", reason: "Welcome email back on after the fix" });
  await store.put("flow-changes", "cart-live", { platform: "klaviyo", action: "live", flow_id: "KF1", reason: "Cart flow back on" });
  assert.deepEqual(await flows(ctx), { queued: 2, parked: 0 });
  assert.equal(sends().length, 0, "no flow changed by the cron");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 2);
  for (const ap of aps) await approve(WF, store, ap.id, "owner", NOW);
  assert.ok(hits.some((h) => h.method === "POST" && h.path === "/3.0/automations/wf1/emails/e1/actions/start"));
  const patch = hits.find((h) => h.method === "PATCH" && h.path === "/api/flows/KF1")!;
  assert.deepEqual(patch.body, { data: { type: "flow", id: "KF1", attributes: { status: "live" } } });
  assert.deepEqual(await flows(context(WF, S, store, NOW, quiet)), { queued: 0, parked: 0 }, "a second run queues nothing new");
});

test("bad flow changes are parked: an unknown action, an unsafe id, and a platform the client does not use", async () => {
  const store = new MemoryStore();
  await store.put("flow-changes", "bad-action", { platform: "mailchimp", action: "send", workflow_id: "wf1", email_id: "e1", reason: "x" });
  await store.put("flow-changes", "bad-id", { platform: "mailchimp", action: "pause", workflow_id: "../../x", email_id: "e1", reason: "x" });
  await store.put("flow-changes", "not-set-up", { platform: "klaviyo", action: "live", flow_id: "KF1", reason: "x" });
  const only = { ...S, platforms: ["mailchimp"] };
  assert.deepEqual(await flows(context(WF, only, store, NOW, quiet)), { queued: 0, parked: 3 });
  assert.equal((await store.get<any>("flow-changes", "not-set-up"))!.status, "needs-attention");
  assert.match((await store.get<any>("flow-changes", "not-set-up"))!.error, /not set up/);
  assert.equal(sends().length, 0);
  assert.equal(hits.length, 0, "nothing reached the network");
});
