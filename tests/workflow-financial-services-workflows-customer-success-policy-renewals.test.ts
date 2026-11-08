// Policy renewals workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp } from "../industries/financial-services/workflows/customer-success/policy-renewals/index.ts";
import { renewalDate } from "../industries/financial-services/workflows/customer-success/policy-renewals/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/financial-services/workflows/customer-success/policy-renewals/workflow.json", "utf8")) as WorkflowRecord;
const BOX = "broker%40example.com.au";
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let mail: any[] = [];
let rows: any[][] = [];
let draftSeq = 0;

function fake() {
  hits = []; draftSeq = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/mailFolders/inbox/messages") && m === "GET") return json({ value: mail });
      if (p.endsWith("/rows") && m === "GET") return json({ value: rows.map((r) => ({ values: [r] })) });
      if (p.endsWith("/messages") && m === "POST") return json({ id: `AAMkDraft${++draftSeq}` });
      if (/\/messages\/[^/]+\/send$/.test(p) && m === "POST") return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/messages"));
const S: any = {
  business_name: "Test Insurance Broking",
  microsoft_365: { mailbox: "broker@example.com.au", folder: "inbox", underwriter: { name: "Dana", email: "uw@insurer.example" }, register: { drive: "DRIVE1", item: "ITEM1", table: "PolicyRegister" } },
  renewal_lead_days: 45, follow_up: { after_days: [7, 14] },
};
const NOW = new Date("2026-11-09T00:00:00Z");
const DAYS = (n: number) => new Date(NOW.getTime() + n * 864e5);

const REGISTER = [
  ["MV-1001", "Sam Lee", "sam@example.com", "2026-12-01", "2021 Toyota Hilux"],         // 22 days out: due
  ["MV-1002", "Ari Patel", "ari@example.com", "15/12/2026", "2019 Mazda 3"],            // 36 days out, day first: due
  ["MV-1003", "Jo Kim", "jo@example.com", "2027-06-01", "2020 Subaru Forester"],        // far off: not due
  ["MV-1004", "Bad Email", "not-an-email", "2026-11-20", "Ute"],                        // due, no usable email: parked
  ["MV-1005", "Lee <b>x</b>", "lee@example.com", 46346, "Van"],                         // Excel date 20 Nov 2026: due, name escaped
];
const from = (address: string, name: string) => ({ emailAddress: { address, name } });
const MAIL = [
  { id: "M1", subject: "Endorse policy MV-2001: add my son as a driver", from: from("pat@example.com", "Pat Doe"), receivedDateTime: "2026-11-08T23:00:00Z", bodyPreview: "Please add my son as a driver on policy MV-2001." },
  { id: "M2", subject: "Re: Endorsement request", from: from("uw@insurer.example", "Dana"), receivedDateTime: "2026-11-08T23:30:00Z", bodyPreview: "Premium change is $42 for the year." },
  { id: "M3", subject: "Lunch on Friday?", from: from("friend@example.com", "Friend"), receivedDateTime: "2026-11-08T23:40:00Z", bodyPreview: "Are you free?" },
];

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  mail = MAIL; rows = REGISTER;
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("renewal dates: ISO, day-first, Excel serial; anything else is unreadable", () => {
  assert.equal(renewalDate("15/12/2026")?.toISOString().slice(0, 10), "2026-12-15");
  assert.equal(renewalDate("2026-12-01")?.toISOString().slice(0, 10), "2026-12-01");
  assert.equal(renewalDate(46346)?.toISOString().slice(0, 10), "2026-11-20");
  assert.equal(renewalDate("31/02/2026"), undefined);
  assert.equal(renewalDate("next March"), undefined);
});

test("intake sorts the folder into endorsements, underwriter replies and needs-review; re-runs add nothing; nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 3, replied: 0 });
  const items = await store.list<any>("renewals");
  const kinds = Object.values(items).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["endorsement", "needs-review", "underwriter-reply"]);
  assert.equal(Object.values(items).find((i) => i.kind === "endorsement")!.policy, "MV-2001");
  assert.deepEqual(await intake(ctx), { added: 0, replied: 0 });
  assert.equal(sends().length, 0);
});

test("draft: due renewals and the endorsement become Outlook drafts with queued sends; the bad row is parked; re-runs never repeat", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 4, needs_review: 1 });
  assert.equal(drafts().length, 4, "one Outlook draft each");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 4);
  assert.ok(pending.some((a) => a.summary.includes("underwriter uw@insurer.example")));
  const lee = drafts().find((h) => h.body.toRecipients[0].emailAddress.address === "lee@example.com")!;
  assert.ok(!lee.body.body.content.includes("<b>x</b>"), "client name is escaped");
  assert.ok(lee.body.body.content.includes("&lt;b&gt;"));
  assert.equal(Object.values(await store.list<any>("renewals")).find((i) => i.policy === "MV-1003"), undefined, "far-off policy untouched");
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_review: 0 });
  assert.equal(drafts().length, 4);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 4);
});

test("approval sends each email once; sent items are marked; a client reply stops the chasing; follow-ups queue when due", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  await draft(context(WF, S, store, NOW, () => {}));
  const t1 = DAYS(1);
  for (const ap of Object.values(await store.list<Approval>("approvals"))) await approve(WF, store, ap.id, "owner", t1);
  assert.equal(sends().length, 4, "one send per approved email");
  const [first] = Object.values(await store.list<Approval>("approvals"));
  await assert.rejects(approve(WF, store, first.id, "owner", t1), /already done/);
  assert.equal(sends().length, 4, "no double send");

  mail = [{ id: "M4", subject: "Renewal: yes, I have a new car", from: from("sam@example.com", "Sam Lee"), receivedDateTime: "2026-11-10T01:00:00Z", bodyPreview: "Yes, I got a new car." }];
  assert.deepEqual(await intake(context(WF, S, store, DAYS(2), () => {})), { added: 0, replied: 1 });

  assert.deepEqual(await followUp(context(WF, S, store, DAYS(3), () => {})), { sent: 3, queued: 0 }, "three approved sends marked sent; none due yet");
  const due = DAYS(9);
  const r = await followUp(context(WF, S, store, due, () => {}));
  assert.deepEqual(r, { sent: 0, queued: 3 }, "the client who replied is not chased; the other client and the underwriter are");
  assert.deepEqual(await followUp(context(WF, S, store, due, () => {})), { sent: 0, queued: 0 }, "a follow-up is queued once");
  assert.equal(sends().length, 4, "follow-ups wait for approval");
});
