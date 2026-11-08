// Supplier quote comparison workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/manufacturing/workflows/fulfilment/supplierquotes/index.ts";
import fs from "node:fs";

const FOLDER = "industries/manufacturing/workflows/fulfilment/supplierquotes";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const ARI = "ari@supplier.example", SAM = "sam@supplier.example", OTHER = "nobody@elsewhere.example";
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = {
  business_name: "Test Fabrication",
  microsoft_365: { mailbox: "buyer@example.com", quote_folder: "inbox", reply_search: "Quote",
                   register: { drive: "DRIVE1", item: "ITEM1", table: "QuoteRegister" } },
  chase_after_days: [3, 7],
};
const CMP = {
  id: "CMP-042", title: "Laser-cut brackets, 3 mm mild steel", created: "2026-11-06T00:00:00Z", status: "open",
  lines: [{ item: "Bracket B3", qty: 240, unit: "ea", spec: "3 mm mild steel, powder coat" }],
  suppliers: [{ name: "Ari Metals", email: ARI }, { name: "Sam Steel", email: SAM }],
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let replyList: any[] = [];
let drafts = 0;

function fake() {
  hits = []; replyList = []; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") { drafts++; return json({ id: `AAMkDraft${drafts}` }); }
      if (p.endsWith("/mailFolders/inbox/messages")) return json({ value: replyList });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafted = () => hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");
const rows = () => hits.filter((h) => h.path.endsWith("/rows") && h.method === "POST");
const reply = (id: string, from: string, subject: string, preview: string) => ({
  id, subject, from: { emailAddress: { address: from } }, receivedDateTime: "2026-11-08T01:00:00Z", bodyPreview: preview,
});

test("runtime: a cron cannot run a live operation as a draft, or queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("crons never send: intake, compare and chase run, and only the chaser is queued", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  replyList = [reply("m1", ARI, "Quote CMP-042 brackets", "Price 14.20 each, 3 weeks")];
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS.intake(ctx()), { logged: 1 });
  assert.deepEqual(await CRONS.compare(ctx()), { drafted: 1 });
  assert.deepEqual(await CRONS.chase(ctx()), { queued: 1 }, "only Sam has not quoted");
  assert.equal(sends().length, 0, "no cron sent anything");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].acts[0].op, "users.user.messages.message.send");
});

test("intake: logs only replies from listed suppliers to the open comparison, once", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  replyList = [
    reply("m1", ARI, "Quote CMP-042 brackets", "Price 14.20 each, 3 weeks"),
    reply("m2", OTHER, "Quote CMP-042", "Our price is lower"),          // not a supplier on this comparison
    reply("m3", ARI, "Lunch on Friday?", "Are you free"),               // no comparison reference
    reply("m4", ARI, "Quote CMP-0421 other job", "Different job"),      // a longer reference is not this one
  ];
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS.intake(ctx()), { logged: 1 });
  assert.equal(rows().length, 1);
  const c = await store.get<any>("comparisons", CMP.id);
  assert.equal(c.replies.length, 1);
  assert.equal(c.replies[0].supplier, "Ari Metals");
  assert.deepEqual(await CRONS.intake(ctx()), { logged: 0 }, "re-runs never log a reply twice");
  assert.equal(rows().length, 1);
});

test("compare: one draft per set of quotes, escaped, never sent; a re-run drafts nothing new", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  replyList = [reply("m1", ARI, "Quote CMP-042", "<img src=x onerror=alert(1)> Price 14.20")];
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await CRONS.intake(ctx());
  assert.deepEqual(await CRONS.compare(ctx()), { drafted: 1 });
  assert.deepEqual(await CRONS.compare(ctx()), { drafted: 0 });
  const d = drafted();
  assert.equal(d.length, 1);
  assert.match(d[0].body.body.content, /&lt;img src=x/);
  assert.ok(!d[0].body.body.content.includes("<img"), "supplier text never becomes markup");
  assert.deepEqual(d[0].body.toRecipients, [], "the comparison has no recipients: it sits in Drafts");
  replyList = [...replyList, reply("m2", SAM, "Quote CMP-042", "Price 15.00 each")];
  await CRONS.intake(ctx());
  assert.deepEqual(await CRONS.compare(ctx()), { drafted: 1 }, "a new quote gets a new comparison draft");
  assert.equal(sends().length, 0);
});

test("chase: due chasers are drafted and queued once; a re-run queues nothing new", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  const ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS.chase(ctx()), { queued: 2 });
  assert.equal(drafted().length, 2);
  assert.deepEqual(await CRONS.chase(ctx()), { queued: 0 }, "round 2 is not due yet");
  // A lost save: the stored counter goes back, but the drafts and approvals already exist.
  await store.put("comparisons", CMP.id, { ...(await store.get<any>("comparisons", CMP.id)), chases: 0 });
  assert.deepEqual(await CRONS.chase(ctx()), { queued: 2 });
  assert.equal(drafted().length, 2, "no second draft for the same supplier and round");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2, "no double queue");
  assert.equal(sends().length, 0);
});

test("approval runs the chaser send exactly once", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  await CRONS.chase(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.id.localeCompare(b.id));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/messages\/AAMkDraft\d+\/send$/);
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("comparisons with a bad reference or a closed status are ignored", async () => {
  const store = new MemoryStore();
  await store.put("comparisons", CMP.id, CMP);
  await store.put("comparisons", "BADID", { ...CMP, id: "bad id!" });
  await store.put("comparisons", "CMP-077", { ...CMP, id: "CMP-077", status: "closed" });
  await CRONS.chase(context(WF, SETTINGS, store, NOW, () => {}));
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 2);
  assert.ok(aps.every((a) => a.acts[0].key?.includes("CMP-042")), "only the open, valid comparison is chased");
});

test("the three crons in the record all exist, and every one is a function", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.entry} is a function`);
});
