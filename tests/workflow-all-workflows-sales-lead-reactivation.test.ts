// Lead reactivation workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { listBuild, queueSend, followUp, CRONS } from "../industries/all/workflows/sales/lead-reactivation/index.ts";
import type { Candidate } from "../industries/all/workflows/sales/lead-reactivation/types.ts";

const DIR = "industries/all/workflows/sales/lead-reactivation";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const DAY = 864e5;
const NOW = new Date("2026-11-08T00:00:00Z");
const CAMPAIGN = "CMP1234567890";
const KLAVIYO_CAMPAIGN = "01JABCDEFGH";

type Hit = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
let hits: Hit[] = [];
let contacts: { id: string; email: string; tags: string[] }[] = [];

/** 250 contacts. Even ones carry the lapsed tag; contact 0 also carries the sent tag, so it is never picked up. */
function seed() {
  contacts = Array.from({ length: 250 }, (_, i) => {
    const id = `ctc${String(i).padStart(4, "0")}`;
    const tags = i % 2 === 0 ? ["past-client"] : ["newsletter"];
    if (i === 0) tags.push("reactivation-sent");
    return { id, email: `person${i}@example.com`, tags };
  });
}

function fake() {
  hits = [];
  seed();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, headers: Object.fromEntries(new Headers(init?.headers ?? {})), body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p === "/contacts/" && m === "GET") {
        const after = u.searchParams.get("startAfterId");
        const start = after ? contacts.findIndex((c) => c.id === after) + 1 : 0;
        const page = contacts.slice(start, start + 100);
        return json({ contacts: page, count: page.length });
      }
      if (/^\/contacts\/[^/]+\/campaigns\/[^/]+$/.test(p) && m === "POST") return json({});
      if (/^\/contacts\/[^/]+\/tags$/.test(p) && m === "POST") return json({ tags: [] });
      if (/^\/contacts\/[^/]+\/tasks$/.test(p) && m === "POST") return json({ task: {} });
      if (p === "/api/campaign-send-jobs" && m === "POST") return json({ data: { type: "campaign-send-job", id: "job1" } }, 202);
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const GHL: any = { business_name: "Test Coaching", send: "gohighlevel", location_id: "LOC1234567890", lapsed_tag: "past-client",
  sent_tag: "reactivation-sent", campaign_id: CAMPAIGN, batch: 5, per_run: 50, max_pages: 60, task_after_days: 7 };
const KLV: any = { business_name: "Test Coaching", send: "klaviyo", lapsed_tag: "past-client", sent_tag: "reactivation-sent",
  klaviyo: { campaign_id: KLAVIYO_CAMPAIGN, revision: "2026-10-15" } };
const at = (s: any, when = NOW, store = new MemoryStore()) => ({ store, ctx: context(WF, s, store, when, () => {}) });

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "ghl-test-token", KLAVIYO_API_KEY: "klv-test-key", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation, and cannot queue a draft one; refused settings never reach the network", async () => {
  const { ctx } = at(GHL);
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: ENROL_OP, input: { params: { contactId: "ctc0001", campaignId: CAMPAIGN } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "klaviyo", op: "send_campaign", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gohighlevel", op: "contacts.add-tags", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
  await assert.rejects(listBuild(context(WF, { ...GHL, location_id: "bad id/../x" }, new MemoryStore(), NOW, () => {})), /location_id/);
  await assert.rejects(queueSend(context(WF, { ...KLV, klaviyo: { campaign_id: "../x" } }, new MemoryStore(), NOW, () => {})), /campaign_id/);
  assert.equal(hits.length, 0);
});

const ENROL_OP = "contacts.add-contact-to-campaign";

test("list-build reads the lapsed contacts across pages, skips the sent ones, and sends nothing", async () => {
  const { store, ctx } = at(GHL);
  assert.deepEqual(await listBuild(ctx), { lapsed: 124, added: 124 });
  assert.ok(hits.length >= 3, "three pages read");
  assert.ok(hits.every((h) => h.method === "GET"), "list-build only reads");
  assert.equal(Object.keys(await store.list("candidates")).length, 124);
  assert.deepEqual(await listBuild(ctx), { lapsed: 124, added: 0 }, "a second read adds nothing");
});

test("queue-send queues enrolments in approvals of five, enrols nothing itself, and never queues a contact twice", async () => {
  const { store, ctx } = at(GHL);
  await listBuild(ctx);
  assert.deepEqual(await queueSend(ctx), { queued: 50 });
  assert.equal(hits.filter((h) => h.path.includes("/campaigns/")).length, 0, "no enrolment by a cron");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 10);
  assert.ok(aps.every((a) => a.status === "pending" && a.acts.length === 5));
  assert.ok(aps.every((a) => a.acts.every((x) => x.op === ENROL_OP)));
  assert.match(aps[0].summary, /^Enrol 5 in campaign CMP1234567890/);
  await queueSend(ctx);
  assert.deepEqual(await queueSend(ctx), { queued: 24 }, "the last 24 lapsed contacts");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 25);
  assert.deepEqual(await queueSend(ctx), { queued: 0 }, "a run with nothing left queues nothing");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 25);
  assert.equal(hits.filter((h) => h.path.includes("/campaigns/")).length, 0);
});

test("an approved enrolment runs; the next run tags the contact sent; the follow-up task waits, then comes once", async () => {
  const { store, ctx } = at(GHL);
  await listBuild(ctx);
  await queueSend(ctx);
  const [first] = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.id.localeCompare(b.id));
  const ap = await approve(WF, store, first.id, "owner", NOW);
  assert.equal(ap.status, "done");
  const enrols = hits.filter((h) => h.method === "POST" && /\/campaigns\//.test(h.path));
  assert.equal(enrols.length, 5);
  assert.ok(enrols.every((h) => h.path.endsWith(`/campaigns/${CAMPAIGN}`)));

  await queueSend(ctx);
  assert.equal(hits.filter((h) => h.path.endsWith("/tags")).length, 5, "each enrolled contact tagged once");
  assert.equal(Object.values(await store.list<Candidate>("candidates")).filter((c) => c.status === "sent").length, 5);
  await queueSend(ctx);
  assert.equal(hits.filter((h) => h.path.endsWith("/tags")).length, 5, "tagging never repeats");

  assert.deepEqual(await followUp(at(GHL, new Date(NOW.getTime() + 6 * DAY), store).ctx), { tasked: 0 }, "too early");
  assert.deepEqual(await followUp(at(GHL, new Date(NOW.getTime() + 8 * DAY), store).ctx), { tasked: 5 });
  assert.deepEqual(await followUp(at(GHL, new Date(NOW.getTime() + 9 * DAY), store).ctx), { tasked: 0 }, "a task is made once");
  assert.equal(hits.filter((h) => h.path.endsWith("/tasks")).length, 5);
  assert.ok(hits.filter((h) => h.path.endsWith("/tasks")).every((h) => h.body.completed === false && h.body.title.startsWith("Reactivation check: person")));
});

test("a rejected enrolment is not queued again", async () => {
  const { store, ctx } = at(GHL);
  await listBuild(ctx);
  await queueSend(ctx);
  const aps = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.id.localeCompare(b.id));
  await reject(WF, store, aps[0].id, "owner", NOW);
  await queueSend(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 20, "the next 50 were queued; the rejected batch was not queued again");
  assert.equal(Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "rejected").length, 1);
});

test("klaviyo: one send is queued, not run; approval sends the campaign's send job with the revision header; a second run queues nothing new", async () => {
  const { store, ctx } = at(KLV);
  assert.deepEqual(Object.keys(await queueSend(ctx)), ["queued_send"]);
  await queueSend(ctx);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, "send_campaign");
  assert.equal(hits.filter((h) => h.path === "/api/campaign-send-jobs").length, 0, "queued, not sent");
  assert.deepEqual(await followUp(at(KLV).ctx), { skipped: "klaviyo sends have no per-contact task" });
  assert.deepEqual(await listBuild(at(KLV).ctx), { skipped: "send is klaviyo: the audience is that campaign's segment" });

  await approve(WF, store, aps[0].id, "owner", NOW);
  const job = hits.find((h) => h.path === "/api/campaign-send-jobs")!;
  assert.equal(job.method, "POST");
  assert.deepEqual(job.body, { data: { type: "campaign-send-job", id: KLV_ID } });
  assert.equal(job.headers.revision, "2026-10-15");
});
const KLV_ID = KLAVIYO_CAMPAIGN;

test("workflow.json and the crons agree: draft ops are reads, tags and tasks only; every cron is listed and exported", () => {
  assert.deepEqual([...WF.draft_ops.gohighlevel].sort(), ["contacts.add-tags", "contacts.create-task", "contacts.get-contacts"]);
  assert.ok(!Object.values(WF.draft_ops).flat().some((op) => /send|campaign|sms|email|message|workflow|delete/i.test(op)), "no send in draft ops");
  assert.ok(WF.live_ops.gohighlevel.includes(ENROL_OP) && WF.live_ops.klaviyo.includes("send_campaign"));
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  assert.equal(WF.id, "lead-reactivation");
  assert.equal(WF.crons.length, 3);
});
