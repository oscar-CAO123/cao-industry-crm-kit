// Expiry alerts workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS, scan, remind, digest } from "../industries/all/workflows/compliance-safety/expiry-alerts/index.ts";
import { parseExpiry } from "../industries/all/workflows/compliance-safety/expiry-alerts/types.ts";
import fs from "node:fs";

const FOLDER = "industries/all/workflows/compliance-safety/expiry-alerts";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const BOX = "compliance@example.com.au";
const S: any = { business_name: "Test Electrical", owner_email: "owner@example.com.au",
  microsoft_365: { mailbox: BOX, register: { drive: "DRV1", item: "ITEM1", table: "Expiry" } }, remind_within_days: 30, digest_within_days: 90 };
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
// Holder | Email | Item | Expiry
const ROWS: unknown[][] = [
  ["Sam <i>Lee</i>", "sam@example.com", "Working at heights licence", "2026-11-20"],   // due in 12 days
  ["Ari Patel", "ari@example.com", "Public liability certificate", serial(2026, 10, 1)], // lapsed, Excel date value
  ["Jo Kim", "not-an-email", "Forklift ticket", "15/11/2026"],                         // due in 7 days, no valid email
  ["Tom Ng", "tom@example.com", "Asbestos awareness", "sometime"],                     // unreadable date
  ["Kim Yu", "kim@example.com", "Confined space", "2027-03-01"],                        // ok, 113 days
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let seq = 0;
function fake() {
  hits = []; seq = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/rows") && m === "GET") return json({ value: ROWS.map((values, index) => ({ index, values: [values] })) });
      if (/\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: `AAMk${++seq}` });
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const drafts = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const sends = () => hits.filter((h) => /\/send$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
});

test("dates: ISO, Australian and Excel cells read; a day that does not exist or unreadable text does not", () => {
  assert.equal(parseExpiry("2026-11-20"), "2026-11-20");
  assert.equal(parseExpiry("20/11/2026"), "2026-11-20");
  assert.equal(parseExpiry(serial(2026, 10, 1)), "2026-10-01");
  assert.equal(parseExpiry("31/02/2027"), undefined);
  assert.equal(parseExpiry("sometime"), undefined);
});

test("scan reads the register, classifies every row, and writes nothing to the platform", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await scan(ctx), { items: 5, expired: 1, due: 2, ok: 1, unknown: 1 });
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "no write from scan");
  assert.equal(Object.keys(await store.list("expiry-items")).length, 5);
});

test("remind drafts one holder reminder each, queues every send, and a re-run adds nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await remind(ctx), { drafted: 2, no_email: 1 });
  assert.equal(drafts().length, 2);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending" && a.acts[0].op === "users.user.messages.message.send"));
  const sam = drafts().find((h) => h.body.toRecipients[0].emailAddress.address === "sam@example.com")!.body;
  assert.equal(sam.subject, "Renewal due: Working at heights licence");
  assert.ok(sam.body.content.includes("Sam &lt;i&gt;Lee&lt;/i&gt;"), "holder name is escaped");
  assert.ok(!sam.body.content.includes("<i>"));
  assert.ok(drafts().some((h) => h.body.subject === "Expired: Public liability certificate"));
  await remind(ctx);
  assert.equal(drafts().length, 2, "re-runs never draft twice");
  assert.equal(Object.values(await store.list("approvals")).length, 2, "re-runs never queue twice");
});

test("a queued reminder is sent only when approved, and only once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await remind(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals")).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(sends().length, 0);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/messages\/AAMk\d+\/send$/);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
  assert.equal(sends().length, 1);
});

test("the runtime refuses a send as a cron draft, and a draft as a queued live act", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "drives.items.workbook.tables.ListRows", summary: "x" }), /not a live operation/);
});

test("owner digest: one draft a day, escaped, listing lapsed and soon-due items, never sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await digest(ctx), { drafted: 1, items: 3 });
  const d = drafts().find((h) => h.body.toRecipients[0].emailAddress.address === "owner@example.com.au")!.body;
  assert.equal(d.subject, "Expiry digest 2026-11-08");
  assert.ok(d.body.content.includes("Jo Kim") && d.body.content.includes("(no valid email on file)"));
  assert.ok(!d.body.content.includes("Kim Yu"), "items beyond the window stay out");
  assert.equal(sends().length, 0);
  assert.equal(Object.values(await store.list("approvals")).length, 0, "the digest is never queued");
  assert.deepEqual(await digest(ctx), { drafted: 0, items: 0 }, "one digest a day");
});

test("every cron named in workflow.json exists, and no send is a draft operation", () => {
  for (const c of WF.crons) assert.equal(typeof CRONS[c.entry], "function", `${c.entry} is exported`);
  assert.ok(!(WF.draft_ops["microsoft-365"] ?? []).some((op) => /send/.test(op)));
  assert.deepEqual(WF.live_ops["microsoft-365"], ["users.user.messages.message.send"]);
});
