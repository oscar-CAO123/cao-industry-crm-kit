// Vendor report workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, draft, CRONS } from "../industries/real-estate/workflows/customer-success/add-vendor/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/customer-success/add-vendor/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-09T21:30:00Z");
const DATE = "2026-11-09";
const DRAFT_ID = "AAMkDraft1";
const S: any = {
  business_name: "Test Realty",
  vendors: [{ property_id: 101, name: "Pat", email: "pat@example.com" }],
  vaultre: { open_home_days: 7 },
  microsoft_365: { mailbox: "listings@example.com" },
};
const COMMENTARY = { text: "Two open homes this week and steady enquiry.\n\nWe will review the price next Thursday." };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let failSend = 0;

function fake() {
  hits = []; failSend = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // VaultRE
      if (/\/properties\/101$/.test(p) && m === "GET") return json({ id: 101, saleLifeId: 555, heading: "Family home", displayAddress: "1 Test St, Testville", displayPrice: "$1.2m" });
      if (/\/properties\/101\/sale\/555\/openHomes$/.test(p) && m === "GET") return json({ items: [
        { id: 1, start: new Date(NOW.getTime() - 2 * 864e5).toISOString(), end: new Date(NOW.getTime() - 2 * 864e5 + 3600e3).toISOString() },
        { id: 2, start: new Date(NOW.getTime() - 20 * 864e5).toISOString(), end: new Date(NOW.getTime() - 20 * 864e5 + 3600e3).toISOString() },
      ] });
      if (/\/properties\/101\/activityLog$/.test(p) && m === "POST") return json({ id: 9 });
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) { if (failSend-- > 0) return new Response("{}", { status: 500 }); return new Response(null, { status: 202 }); }
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: DRAFT_ID });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { VAULTRE_ACCESS_TOKEN: "vt", VAULTRE_API_KEY: "vk", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("crons are the two named in workflow.json", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
});

test("runtime: a cron cannot run a live operation as a draft, and cannot queue a draft operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "vaultre", op: "addPropertyActivityNote", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "vaultre", op: "sendContactEmail", summary: "x" }), /not a draft operation/);
});

test("runtime: the SDK gate still blocks writes when the deploy does not allow them", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.CreateMessages", input: { params: { "user-id": "a@b.co" }, body: {} }, summary: "x" }), WriteBlocked);
  assert.equal(writes().length, 0);
});

test("pull reads the listing and its open homes, and writes nothing to VaultRE", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await pull(ctx), { read: 1 });
  assert.equal(writes().length, 0, "no writes from the pull");
  const f: any = await store.get("properties", "101");
  assert.equal(f.sale_life_id, 555);
  assert.equal(f.address, "1 Test St, Testville");
  assert.equal(f.open_homes.length, 1, "only the open home inside the 7 day window");
});

test("draft waits for commentary: no Outlook draft, no queue", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, waiting: 1 });
  assert.equal(drafts().length, 0);
  assert.equal(writes().filter((h) => h.path.endsWith("/activityLog")).length, 0);
  const r: any = await store.get("reports", `101:${DATE}`);
  assert.equal(r.status, "needs-commentary");
  assert.deepEqual(await store.list("approvals"), {});
});

test("with commentary: one Outlook draft and one queued send; nothing is sent by the cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "101", COMMENTARY);
  assert.deepEqual(await draft(ctx), { drafted: 1, waiting: 0 });
  assert.equal(drafts().length, 1, "one Outlook draft");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const note = hits.find((h) => h.path.endsWith("/activityLog"));
  assert.ok(note, "activity note written to the listing");
  assert.equal(note!.body.saleLifeId, 555);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].acts[0].op, "users.user.messages.message.send");
  assert.equal(pending[0].acts[0].input?.params?.["message-id"], DRAFT_ID);
  assert.match(pending[0].summary, /pat@example\.com/);
});

test("the report email is escaped and carries only the stored figures", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "101", { text: "Good <b>week</b> & calm" });
  await draft(ctx);
  const body = drafts()[0].body;
  assert.match(body.body.content, /Good &lt;b&gt;week&lt;\/b&gt; &amp; calm/);
  assert.equal(body.toRecipients[0].emailAddress.address, "pat@example.com");
  assert.equal(body.body.contentType, "HTML");
});

test("re-runs never draft or queue the same report twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "101", COMMENTARY);
  await draft(ctx);
  const before = writes().length;
  assert.deepEqual(await draft(ctx), { drafted: 0, waiting: 0 });
  assert.equal(writes().length, before, "second run wrote nothing");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("a run that stops after the draft is queued again without drafting again", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "101", COMMENTARY);
  await store.put("reports", `101:${DATE}`, { key: `101:${DATE}`, property_id: 101, date: DATE, to: "pat@example.com", subject: "x",
    status: "draft-made", created: NOW.toISOString(), message_id: "AAMkEarlier" });
  await draft(ctx);
  assert.equal(drafts().length, 0, "the earlier draft is reused");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending[0].acts[0].input?.params?.["message-id"], "AAMkEarlier");
});

test("approval sends the Outlook draft once, and a second approval is refused", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pull(ctx);
  await store.put("commentary", "101", COMMENTARY);
  await draft(ctx);
  const pending = Object.values(await store.list<Approval>("approvals"))[0];
  const done = await approve(WF, store, pending.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1, "the send ran once, on approval");
  assert.match(sends()[0].path, new RegExp(`/messages/${DRAFT_ID}/send$`));
  await assert.rejects(approve(WF, store, pending.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1);
});
