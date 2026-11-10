// PR and media workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pitch, followUp, report, CRONS } from "../industries/all/workflows/marketing/pr-media/index.ts";
import { replyTime } from "../industries/all/workflows/marketing/pr-media/adapters/google-workspace.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/marketing/pr-media";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "pitch@example.com";
const NOW = new Date("2026-11-08T00:00:00Z");
const DAY = 864e5;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let replied = new Set<string>();   // thread ids that have a message from outside
let made = 0;

function fake() {
  hits = []; replied = new Set(); made = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") {
        made++;
        return json({ id: `r-draft-${made}`, message: { id: `m-${made}`, threadId: `thr${made}` } });
      }
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: `sent-${body?.id}`, threadId: "thr-sent" });
      const t = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(p);
      if (t && m === "GET") {
        const id = t[1];
        const messages: any[] = [{ id: `s-${id}`, labelIds: ["SENT"], internalDate: "1762560000000", snippet: "our pitch" }];
        if (replied.has(id)) messages.push({ id: `i-${id}`, labelIds: ["INBOX", "UNREAD"], internalDate: "1762600000000", snippet: "Yes, tell me more" });
        return json({ id, messages });
      }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const drafts = () => hits.filter((h) => h.method === "POST" && h.path === "/gmail/v1/users/me/drafts");
const sends = () => hits.filter((h) => h.method === "POST" && h.path === "/gmail/v1/users/me/drafts/send");
const headerOf = (d: Hit) => Buffer.from(d.body.message.raw, "base64url").toString("utf8").split("\r\n\r\n")[0];

const SETTINGS: any = {
  business_name: "Test Agency",
  release: { id: "spring-opening", subject: "Test Co opens its second site", text: "Hi {name},\n\nTest Co opens its second site on 1 December. Happy to arrange an interview.\n\nThanks" },
  media_list: [
    { name: "Ari Patel", email: "ari@news.example", outlet: "Trade Weekly" },
    { name: "Kim Ross", email: "kim@paper.example", outlet: "City Paper" },
    { name: "Not An Address", email: "not-an-address" },
  ],
  report_to: "owner@example.com",
  follow_up: { after_days: [3, 7] },
  max_pitches_per_run: 10,
};

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation is never a draft, and a draft is never queued as live", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", input: { body: { id: "x" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.drafts.create", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("crons never send: a pitch run drafts and queues one send per approved journalist, and skips a bad address", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await pitch(ctx), { drafted: 2, skipped: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(drafts().length, 2);
  assert.match(headerOf(drafts()[0]), /To: ari@news\.example/);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 2);
  assert.ok(aps.every((a) => a.status === "pending" && a.acts[0].op === "gmail.users.drafts.send"));
});

test("re-runs never draft or queue a pitch twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pitch(ctx); await pitch(ctx);
  assert.equal(drafts().length, 2, "no second draft for the same journalist");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2);
});

test("an approved pitch is sent once from its own draft; replies stop the chase; due follow-ups are queued once", async () => {
  const store = new MemoryStore();
  await pitch(context(WF, SETTINGS, store, NOW, () => {}));
  const pitches = Object.values(await store.list<any>("pitches"));
  const ari = pitches.find((p) => p.to === "ari@news.example")!, kim = pitches.find((p) => p.to === "kim@paper.example")!;
  for (const p of [ari, kim]) await approve(WF, store, approvalId(WF.id, `send:${p.key}`), "owner", NOW);
  assert.deepEqual(sends().map((s) => s.body), [{ id: ari.draft_id }, { id: kim.draft_id }], "each approved send names its own draft");

  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 2 * DAY), () => {})), { queued: 0, replies: 0 });
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 4 * DAY), () => {})), { queued: 2, replies: 0 });

  replied.add(ari.thread_id);
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 4 * DAY), () => {})), { queued: 0, replies: 1 });
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 8 * DAY), () => {})), { queued: 1, replies: 0 }, "only the journalist who has not replied is chased again");
  const last = drafts().at(-1)!;
  assert.equal(last.body.message.threadId, kim.thread_id, "a follow-up is drafted into its pitch thread");
  assert.equal(sends().length, 2, "follow-ups are queued, not sent");
});

test("the report is one draft to the owner, queued once per day", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await pitch(ctx);
  assert.deepEqual(await report(ctx), { queued: 1 });
  assert.deepEqual(await report(ctx), { queued: 0 }, "a second run the same day queues nothing");
  const toOwner = drafts().filter((d) => headerOf(d).includes("To: owner@example.com"));
  assert.equal(toOwner.length, 1);
  assert.equal(sends().length, 0);
});

test("a thread id from outside is checked before any request", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(replyTime(ctx, "../evil"), /bad thread id/);
  assert.equal(hits.length, 0);
});

test("deploy: the crons match the workflow record, and every target renders them", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
  for (const t of TARGETS) {
    const all = Object.values(render(DIR, SETTINGS, t)).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
  }
});
