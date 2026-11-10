// Referral-partners workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { describe } from "../core/sdk/call.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, acknowledge, progress, CRONS } from "../industries/all/workflows/sales/referral-partners/index.ts";

const FOLDER = "industries/all/workflows/sales/referral-partners";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const LABEL = "11111111-2222-4333-8444-555555555555";
const LEAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", LEAD2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const FIELD = "0123456789abcdef0123456789abcdef01234567";
const PARTNER = "partner@example.com";
const S: any = {
  family: "referral-partners", intake: "pipedrive", partners: "activecampaign",
  pipedrive: { referral_label_id: LABEL, partner_email_field: FIELD },
  activecampaign: { acknowledged_tag: "referral-received", stage_tags: { "2": "referral-approved" } },
};
const NOW = new Date("2026-11-08T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let leads: any[] = [];
let deals: any[] = [];
let contacts: any[] = [];
let dealPages: any[][] | undefined;   // when set, the deals come back one page at a time through next_cursor

const lead =(id: string, title: string, labels: string[], email?: string) => ({ id, title, label_ids: labels, [FIELD]: email });

function fake() {
  hits = [];
  leads = [lead(LEAD, "Sam Lee, car loan", [LABEL], PARTNER)];
  deals = [];
  contacts = [];
  dealPages = undefined;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Pipedrive
      if (p === "/v1/leads" && m === "GET") return json({ success: true, data: leads });
      if (/^\/v1\/leads\/[^/]+$/.test(p) && m === "GET") {
        const l = leads.find((x) => x.id === p.split("/").pop());
        return l ? json({ success: true, data: l }) : new Response("{}", { status: 404 });
      }
      if (p === "/api/v2/deals" && m === "GET") {
        if (!dealPages) return json({ success: true, data: deals });
        const i = u.searchParams.get("cursor") ? Number(u.searchParams.get("cursor")) : 0;
        return json({ success: true, data: dealPages[i], additional_data: { next_cursor: i + 1 < dealPages.length ? String(i + 1) : undefined } });
      }
      // ActiveCampaign
      if (p === "/api/3/contacts" && m === "GET") return json({ contacts });
      if (p === "/api/3/contact/sync" && m === "POST") return json({ contact: { id: "900" } });
      if (/^\/api\/3\/contacts\/\d+\/tags$/.test(p) && m === "POST") return json({ contactTags: [] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake();
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PIPEDRIVE_API_TOKEN: "pd", ACTIVECAMPAIGN_API_KEY: "ac", ACTIVECAMPAIGN_ACCOUNT: "acme", KIT_ALLOW_WRITES: "1" });
});

test("every operation the workflow names exists in the kit's platform catalogue", () => {
  for (const [platform, ops] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) for (const op of ops) describe(platform, op);
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "activecampaign", op: "docs.post_contact_sync", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "activecampaign", op: "docs.get_contacts", summary: "x" }), /not a live operation/);
});

test("intake records only leads with the referral label, and parks one with no partner email", async () => {
  leads = [lead(LEAD, "Referred", [LABEL], PARTNER), lead(LEAD2, "Not a referral", [], PARTNER), lead("not-a-uuid", "Bad id", [LABEL], PARTNER),
           lead("cccccccc-dddd-4eee-8fff-000000000000", "No email", [LABEL], "not an email")];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2, needs_partner_email: 1 });
  assert.equal((await store.get<any>("referrals", `lead:${LEAD}`))!.status, "new");
  assert.equal((await store.get<any>("referrals", "lead:cccccccc-dddd-4eee-8fff-000000000000"))!.status, "needs-partner-email");
  assert.equal(writes().length, 0, "intake writes nothing");
});

test("acknowledge queues one receipt per referral and never sends it itself", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await acknowledge(ctx), { queued: 1, acknowledged: 0, declined: 0 });
  assert.deepEqual(await acknowledge(ctx), { queued: 0, acknowledged: 0, declined: 0 }, "a second run does not queue again");
  assert.equal(writes().length, 0, "no contact write from a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
});

test("approval syncs the partner with the acknowledged tag, then the referral is acknowledged", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await acknowledge(ctx);
  const ap = await approve(WF, store, approvalId(WF.id, `ack:${LEAD}`), "owner", NOW);
  assert.equal(ap.status, "done");
  const sync = hits.find((h) => h.path === "/api/3/contact/sync")!;
  assert.deepEqual(sync.body, { contact: { email: PARTNER, tags: ["referral-received"] } });
  assert.deepEqual(await acknowledge(ctx), { queued: 0, acknowledged: 1, declined: 0 });
  assert.equal((await store.get<any>("referrals", `lead:${LEAD}`))!.status, "acknowledged");
});

test("a referral with no partner email is picked up once the email is filled in", async () => {
  leads = [lead(LEAD, "Referred", [LABEL], undefined)];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await acknowledge(ctx), { queued: 0, acknowledged: 0, declined: 0 }, "nothing queued without an email");
  leads = [lead(LEAD, "Referred", [LABEL], PARTNER)];
  assert.deepEqual(await acknowledge(ctx), { queued: 1, acknowledged: 0, declined: 0 });
});

test("progress queues the stage tag on the existing partner contact, once per stage", async () => {
  const store = new MemoryStore();
  await store.put("referrals", `lead:${LEAD}`, { key: `lead:${LEAD}`, lead_id: LEAD, title: "Referred", partner_email: PARTNER, status: "acknowledged", received: NOW.toISOString() });
  deals = [{ id: 7, stage_id: 2, source_lead_id: LEAD }];
  contacts = [{ id: "555", email: PARTNER }];
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await progress(ctx), { queued: 1 });
  assert.equal(writes().length, 0, "progress writes nothing");
  const ap = await approve(WF, store, approvalId(WF.id, "stage:7:2"), "owner", NOW);
  assert.equal(ap.status, "done");
  const tag = hits.find((h) => h.path === "/api/3/contacts/555/tags")!;
  assert.deepEqual(tag.body, { tags: ["referral-approved"] });
  assert.deepEqual(await progress(ctx), { queued: 0 }, "the same stage is not queued again");
});

test("progress syncs the partner with the stage tag when no contact exists yet", async () => {
  const store = new MemoryStore();
  await store.put("referrals", `lead:${LEAD}`, { key: `lead:${LEAD}`, lead_id: LEAD, title: "Referred", partner_email: PARTNER, status: "acknowledged", received: NOW.toISOString() });
  deals = [{ id: 8, stage_id: 2, source_lead_id: LEAD }];
  contacts = [];
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await progress(ctx), { queued: 1 });
  const ap = await approve(WF, store, approvalId(WF.id, "stage:8:2"), "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(hits.find((h) => h.path === "/api/3/contact/sync")!.body, { contact: { email: PARTNER, tags: ["referral-approved"] } });
});

test("a bad setting stops every cron before any read", async () => {
  const bad = { ...S, pipedrive: { ...S.pipedrive, referral_label_id: "label" } };
  await assert.rejects(intake(context(WF, bad, new MemoryStore(), NOW, () => {})), /referral_label_id/);
  assert.equal(hits.length, 0);
});

test("progress follows every page of changed deals, so a deal past the first page still gets its stage tag", async () => {
  const store = new MemoryStore(), LEAD_FAR = "cccccccc-dddd-4eee-8fff-111111111111";
  await store.put("referrals", `lead:${LEAD}`, { key: `lead:${LEAD}`, lead_id: LEAD, title: "Referred", partner_email: PARTNER, status: "acknowledged", received: NOW.toISOString() });
  await store.put("referrals", `lead:${LEAD_FAR}`, { key: `lead:${LEAD_FAR}`, lead_id: LEAD_FAR, title: "Far", partner_email: PARTNER, status: "acknowledged", received: NOW.toISOString() });
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, stage_id: 9, source_lead_id: LEAD2 }));
  dealPages = [page1, [{ id: 5000, stage_id: 2, source_lead_id: LEAD_FAR }]];
  contacts = [{ id: "555", email: PARTNER }];
  const ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await progress(ctx), { queued: 1 });
  const ap = await approve(WF, store, approvalId(WF.id, "stage:5000:2"), "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(hits.find((h) => h.path === "/api/3/contacts/555/tags")!.body, { tags: ["referral-approved"] });
});
