// Paperwork workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, queue } from "../industries/construction/workflows/fulfilment/paperwork/index.ts";
import { requestKey, type Request } from "../industries/construction/workflows/fulfilment/paperwork/types.ts";
import fs from "node:fs";

const DIR = "industries/construction/workflows/fulfilment/paperwork";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com";

const TEMPLATES: Record<string, string> = {
  tplProgress: "Progress report for {{Client name}}. Total {{Total}}. Notes: {{Notes}}.",
  tplEot: "Dear {{Client name}}. Extension of time claim, total {{Total}}. {{Notes}}",
  tplDelay: "Delay notice for {{Client name}}. Signed {{Signatory}}. {{Notes}}",
};
const HEAD = ["ID", "Document", "Client email", "Status", "Client name", "Total", "Notes"];
const ROWS0: string[][] = [
  HEAD,
  ["R-1", "progress report", "sam@example.com", "ready", "Sam Lee", "$1,200.00", "On track"],
  ["R-2", "extension of time claim", "bad-email", "ready", "Ari Kim", "$0", "Thanks"],
  ["R-3", "delay notice", "kim@example.com", "not yet", "Kim", "0", "-"],
  ["../bad", "delay notice", "a@example.com", "ready", "X", "0", "-"],
  ["R-5", "delay notice", "ok@example.com", "ready", "Jo", "$9", "-"],
  ["R-7", "newsletter", "x@example.com", "ready", "Pat", "1", "none"],
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [], rows: string[][] = [], docs: Record<string, string> = {}, comments: Record<string, any[]> = {};
let copies = 0, drafts: any[] = [], sent: any[] = [], logs: string[][] = [];

function fake() {
  hits = []; rows = ROWS0.map((r) => [...r]); docs = {}; comments = {}; copies = 0; drafts = []; sent = []; logs = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = decodeURIComponent(u.pathname);
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p.startsWith("/v4/spreadsheets/sheet1/values/Requests") && m === "GET") return json({ values: rows });
      if (p.startsWith("/v4/spreadsheets/sheet1/values/Document log") && m === "POST") { logs.push(...body.values); return json({ updates: {} }); }
      const copy = p.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
      if (copy && m === "POST") { copies++; const id = `doc${copies}`; docs[id] = TEMPLATES[copy[1]] ?? ""; return json({ id }); }
      const bu = p.match(/^\/v1\/documents\/([^:/]+):batchUpdate$/);
      if (bu && m === "POST") {
        for (const r of body.requests) docs[bu[1]] = docs[bu[1]].split(r.replaceAllText.containsText.text).join(r.replaceAllText.replaceText);
        return json({});
      }
      const doc = p.match(/^\/v1\/documents\/([^/:]+)$/);
      if (doc && m === "GET") return json({ body: { content: [{ paragraph: { elements: [{ textRun: { content: docs[doc[1]] ?? "" } }] } }] } });
      const cm = p.match(/^\/drive\/v3\/files\/([^/]+)\/comments$/);
      if (cm && m === "GET") return json({ comments: comments[cm[1]] ?? [] });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") { drafts.push(body); return json({ id: `draft${drafts.length}`, message: { id: `m${drafts.length}` } }); }
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") { sent.push(body); return json({ id: "sent1" }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: any = {
  business_name: "Test Construction",
  google: {
    spreadsheet_id: "sheet1",
    records: { range: "Requests!A1:Z500", ready_value: "ready", approved_value: "approved", columns: { id: "ID", kind: "Document", email: "Client email", status: "Status" } },
    log_range: "Document log!A1", output_folder_id: "folderOut",
  },
  documents: [
    { kind: "progress report", template_id: "tplProgress" },
    { kind: "extension of time claim", template_id: "tplEot" },
    { kind: "delay notice", template_id: "tplDelay" },
  ],
};
const NOW = new Date("2026-11-08T00:00:00Z");
const get = (store: MemoryStore, id: string) => store.get<Request>("requests", requestKey(id));
const sendHits = () => hits.filter((h) => h.path.endsWith("/drafts/send"));
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

beforeEach(async () => {
  fake(); setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot run a send as a draft, and cannot queue a draft operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", input: { params: { userId: "me" }, body: { id: "d1" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "gmail.users.drafts.create", summary: "x" }), /not a live operation/);
  assert.equal(sendHits().length, 0);
});

test("intake reads the requests tab only: ready rows with a valid id, nothing written", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 4, skipped: 1 });
  assert.deepEqual(hits.filter((h) => h.method !== "GET" && h.path !== "/token"), []);
  assert.equal((await get(store, "R-1"))?.status, "new");
  assert.deepEqual((await get(store, "R-1"))?.fields, { "Client name": "Sam Lee", Total: "$1,200.00", Notes: "On track" });
  assert.equal(await get(store, "R-3"), undefined, "a row not marked ready is not picked up");
  assert.deepEqual(await intake(ctx), { added: 0, skipped: 1 }, "a record is added once");
});

test("draft copies, fills, drafts the email and logs; a bad email, missing template or unfilled field is parked; nothing is sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_person: 3, held: 0 });
  assert.equal(copies, 2, "copies only for R-1 and R-5; R-2 and R-7 are parked before any copy");
  assert.equal(sendHits().length, 0, "nothing sent by a cron");
  const r1 = await get(store, "R-1");
  assert.equal(r1?.status, "drafted");
  assert.equal(r1?.doc_id, "doc1");
  assert.equal(docs.doc1, "Progress report for Sam Lee. Total $1,200.00. Notes: On track.");
  assert.equal(drafts.length, 1);
  const mime = decode(drafts[0].message.raw);
  assert.match(mime, /^To: sam@example\.com\r\nSubject: progress report from Test Construction\r\n/);
  assert.match(mime, /Progress report for Sam Lee\. Total \$1,200\.00/);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].slice(1), ["R-1", "progress report", "sam@example.com", "drafted", "doc1"]);
  assert.match((await get(store, "R-2"))!.reason!, /no valid client email/);
  assert.match((await get(store, "R-5"))!.reason!, /unfilled fields: \{\{Signatory\}\}/);
  assert.match((await get(store, "R-7"))!.reason!, /no template/);
});

test("re-runs never copy or draft twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_person: 3, held: 0 });
  assert.equal(copies, 2);
  assert.equal(drafts.length, 1);
  assert.equal(logs.length, 1);
});

test("open comments hold the draft until they are resolved, then it is drafted from the same copy", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  comments.doc1 = [{ resolved: false }];
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_person: 3, held: 1 });
  assert.equal((await get(store, "R-1"))?.status, "held");
  assert.equal(drafts.length, 0, "no email draft while comments are open");
  comments = {};
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_person: 3, held: 0 });
  assert.equal(copies, 2, "the held copy is reused, not copied again");
  assert.equal(drafts.length, 1);
});

test("queue: nothing queued until a person marks the record approved; the approval sends once", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await queue(ctx), { queued: 0 });
  rows[1][3] = "approved";
  assert.deepEqual(await queue(ctx), { queued: 1 });
  assert.equal(sendHits().length, 0, "queueing does not send");
  assert.equal((await get(store, "R-1"))?.status, "queued");
  assert.deepEqual(await queue(ctx), { queued: 0 }, "a re-run never queues the same send twice");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.acts.length, 1);
  assert.equal(ap.acts[0].op, "gmail.users.drafts.send");
  assert.deepEqual(ap.acts[0].input, { params: { userId: "me" }, body: { id: "draft1" } });
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sendHits().length, 1);
  assert.deepEqual(sent, [{ id: "draft1" }]);
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
});

test("a misconfigured client fails before any call is made", async () => {
  const ctx = context(WF, { ...SETTINGS, documents: [] }, new MemoryStore(), NOW, () => {});
  await assert.rejects(draft(ctx), /at least one document template/);
  assert.equal(hits.length, 0);
});
