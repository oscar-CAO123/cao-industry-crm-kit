// Documents workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, queue } from "../industries/all/workflows/fulfilment/documents/index.ts";
import { requestKey, type Request } from "../industries/all/workflows/fulfilment/documents/types.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/fulfilment/documents";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com";

const TEMPLATES: Record<string, string> = {
  tplProgress: "Progress report for {{Client name}}. Total {{Total}}. Notes: {{Notes}}.",
  tplLetter: "Dear {{Client name}}. Total {{Total}}. {{Notes}}",
  tplInvoice: "Invoice for {{Client name}}, total {{Total}}, signed {{Signatory}}.",
};
const ROWS = [
  ["ID", "Document", "Client email", "Status", "Client name", "Total", "Notes"],
  ["R-1", "progress report", "sam@example.com", "ready", "Sam Lee", "$1,200.00", "On track"],
  ["R-2", "letter", "bad-email", "ready", "Ari Kim", "$0", "Thanks"],
  ["R-3", "newsletter", "x@example.com", "ready", "Pat", "1", "none"],
  ["R-4", "letter", "kim@example.com", "not yet", "Kim", "0", "-"],
  ["../bad", "letter", "a@example.com", "ready", "X", "0", "-"],
  ["R-6", "invoice", "ok@example.com", "ready", "Jo", "$9", "-"],
];

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [], docs: Record<string, string> = {}, comments: Record<string, any[]> = {};
let copies = 0, shares: any[] = [], logs: string[][] = [], failFillOnce = false;

function fake() {
  hits = []; docs = {}; comments = {}; copies = 0; shares = []; logs = []; failFillOnce = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = decodeURIComponent(u.pathname);
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p.startsWith("/v4/spreadsheets/sheet1/values/Records") && m === "GET") return json({ values: ROWS });
      if (p.startsWith("/v4/spreadsheets/sheet1/values/Document log") && m === "POST") { logs.push(...body.values); return json({ updates: {} }); }
      const copy = p.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
      if (copy && m === "POST") { copies++; const id = `doc${copies}`; docs[id] = TEMPLATES[copy[1]] ?? ""; return json({ id }); }
      const bu = p.match(/^\/v1\/documents\/([^:/]+):batchUpdate$/);
      if (bu && m === "POST") {
        if (failFillOnce) { failFillOnce = false; return new Response("{}", { status: 400 }); }
        for (const r of body.requests) docs[bu[1]] = docs[bu[1]].split(r.replaceAllText.containsText.text).join(r.replaceAllText.replaceText);
        return json({});
      }
      const doc = p.match(/^\/v1\/documents\/([^/:]+)$/);
      if (doc && m === "GET") return json({ body: { content: [{ paragraph: { elements: [{ textRun: { content: docs[doc[1]] ?? "" } }] } }] } });
      const cm = p.match(/^\/drive\/v3\/files\/([^/]+)\/comments$/);
      if (cm && m === "GET") return json({ comments: comments[cm[1]] ?? [] });
      const perm = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
      if (perm && m === "POST") { shares.push({ file: perm[1], ...body }); return json({ id: "perm1" }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const SETTINGS: any = {
  business_name: "Test Services",
  google: {
    spreadsheet_id: "sheet1",
    records: { range: "Records!A1:Z500", ready_value: "ready", columns: { id: "ID", kind: "Document", email: "Client email", status: "Status" } },
    log_range: "Document log!A1", output_folder_id: "folderOut",
  },
  documents: [
    { kind: "progress report", template_id: "tplProgress", fields: ["Client name", "Total", "Notes"] },
    { kind: "letter", template_id: "tplLetter", fields: ["Client name", "Total", "Notes"] },
    { kind: "invoice", template_id: "tplInvoice", fields: ["Client name", "Total", "Signatory"] },
  ],
  share_role: "reader",
};
const NOW = new Date("2026-11-08T00:00:00Z");
const req = async (store: MemoryStore, id: string) => store.get<Request>("requests", requestKey(id));

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("intake: only ready rows with a valid id become requests, once; an unknown kind is flagged for a person", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 4, skipped: 1 });
  assert.equal((await req(store, "R-1"))?.status, "new");
  assert.equal((await req(store, "R-3"))?.status, "needs-person");
  assert.equal(await req(store, "R-4"), undefined, "not-ready rows are ignored");
  assert.deepEqual(await intake(ctx), { added: 0, skipped: 1 }, "re-runs add nothing new");
});

test("intake keeps only the columns the template fills: no contact details or status on the request", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(Object.keys((await req(store, "R-1"))!.fields).sort(), ["Client name", "Notes", "Total"]);
  for (const q of Object.values(await store.list<Request>("requests"))) {
    assert.ok(!["Client email", "Status", "ID", "Document"].some((h) => h in q.fields), `${q.id} keeps a column its template does not fill`);
  }
});

test("bad settings: a template with no fields list is refused before any call", async () => {
  const store = new MemoryStore();
  const bad = { ...SETTINGS, documents: [{ kind: "letter", template_id: "tplLetter" }] };
  await assert.rejects(intake(context(WF, bad, store, NOW, () => {})), /fields list/);
  assert.equal(hits.length, 0);
});

test("draft: copies each template into the output folder, fills it, logs each row, and shares nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 2, needs_person: 1 });
  assert.equal(copies, 3, "one copy per request that had a template");
  assert.ok(hits.filter((h) => /\/copy$/.test(h.path)).every((h) => JSON.stringify(h.body.parents) === '["folderOut"]'));
  assert.equal((await req(store, "R-1"))?.status, "drafted");
  assert.equal(docs["doc1"], "Progress report for Sam Lee. Total $1,200.00. Notes: On track.");
  assert.equal((await req(store, "R-6"))?.status, "needs-person", "an unfilled placeholder goes to a person");
  assert.match((await req(store, "R-6"))!.reason!, /\{\{Signatory\}\}/);
  assert.equal(logs.length, 3, "one log row per processed request");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith(":append")).length, 3);
  assert.equal(shares.length, 0, "nothing shared by a cron");
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_person: 0 });
  assert.equal(copies, 3, "re-runs never copy a template again");
});

test("a run that stops after the copy does not make a second copy", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  failFillOnce = true;
  await assert.rejects(draft(ctx));
  assert.equal(copies, 1);
  assert.equal((await req(store, "R-1"))?.status, "copied");
  await draft(ctx);
  assert.equal(copies, 3, "R-1 was not copied again on the retry");
  assert.equal((await req(store, "R-1"))?.status, "drafted");
});

test("queue: holds a draft with open comments or a bad email; queues the share once comments are resolved; cron never shares", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const r1doc = (await req(store, "R-1"))!.doc_id!;
  comments[r1doc] = [{ id: "c1", resolved: false }];
  assert.deepEqual(await queue(ctx), { queued: 0, held: 2 }, "R-1 held by its open comment, R-2 held for its bad email");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
  comments[r1doc] = [{ id: "c1", resolved: true }];
  assert.deepEqual(await queue(ctx), { queued: 1, held: 1 }, "R-1 queued, R-2 still held");
  assert.equal(shares.length, 0, "nothing shared by a cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1, "one approval, for the one clean draft with a valid email");
  assert.equal(approvals[0].acts[0].op, "drive.permissions.create");
  assert.deepEqual(approvals[0].acts[0].input, { params: { fileId: r1doc, sendNotificationEmail: true }, body: { type: "user", role: "reader", emailAddress: "sam@example.com" } });
  assert.deepEqual(await queue(ctx), { queued: 0, held: 1 }, "a queued request is not queued again");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("approval shares the Doc once; a second approve is refused and does not share again", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx); await queue(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(shares.length, 1);
  assert.deepEqual(shares[0], { file: (await req(store, "R-1"))!.doc_id, type: "user", role: "reader", emailAddress: "sam@example.com" });
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(shares.length, 1);
});

test("live and draft operations stay on their own side of the gate", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "drive.permissions.create", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "drive.files.copy", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("bad settings fail before any call is made", async () => {
  const store = new MemoryStore();
  await assert.rejects(intake(context(WF, { ...SETTINGS, google: { ...SETTINGS.google, spreadsheet_id: "" } }, store, NOW, () => {})), /spreadsheet_id/);
  await assert.rejects(draft(context(WF, { ...SETTINGS, share_role: "writer" }, store, NOW, () => {})), /share_role/);
  assert.equal(hits.length, 0);
});
