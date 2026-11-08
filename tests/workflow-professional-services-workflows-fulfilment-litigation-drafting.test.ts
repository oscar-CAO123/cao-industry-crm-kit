// Litigation drafting workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, fileReview, draft, CRONS } from "../industries/professional-services/workflows/fulfilment/litigation-drafting/index.ts";
import { smokeball } from "../industries/professional-services/workflows/fulfilment/litigation-drafting/adapters/smokeball.ts";
import type { Draft, Matter } from "../industries/professional-services/workflows/fulfilment/litigation-drafting/types.ts";

const FOLDER = "industries/professional-services/workflows/fulfilment/litigation-drafting";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const M1 = "11111111-2222-4333-8444-555555555555", C1 = "87654321-4321-4321-8321-210987654321", STAFF = "STAFF-1";
const S: any = { family: "commercial-litigation", platform: "smokeball", solicitor_staff_id: STAFF, practice_name: "Test Law" };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let files: { id: string; name: string; dateModified?: string; fileExtension?: string }[] = [];
const lead = () => ({ value: [{ id: M1, number: "2026-001", title: "Smith v Jones", status: "Open", clients: [{ id: C1 }] }] });

function fake() {
  hits = [];
  files = [{ id: "22222222-3333-4444-8555-666666666666", name: "Statement of claim.pdf", dateModified: "2026-10-01T09:00:00Z", fileExtension: "pdf" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/matters" && m === "GET") return json(lead());
      if (p === `/matters/${M1}/documents/files` && m === "GET") return json({ value: files });
      if (p === `/matters/${M1}/memos` && m === "POST") return json({ id: "33333333-4444-4555-8666-777777777777" });
      if (p === "/tasks" && m === "POST") return json({ id: "44444444-5555-4666-8777-888888888888" });
      if (p === `/matters/${M1}/portal/messages` && m === "POST") return json({});
      return new Response("{}", { status: 404 });
    }) as any,
  });
}
const hitsTo = (re: RegExp) => hits.filter((h) => re.test(h.path));
const memos = () => hitsTo(/\/memos$/).filter((h) => h.method === "POST");
const portal = () => hitsTo(/\/portal\/messages$/);

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SMOKEBALL_ACCESS_TOKEN: "tok", SMOKEBALL_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
});

const pendingDraft = (over: Partial<Draft> = {}): Draft => ({
  key: "draft-smith-1", matter: M1, title: "Draft defence v1", status: "pending", created: NOW.toISOString(),
  text: "Allegation 1: admit. Allegation 2: deny, the goods were delivered on 3 May.",
  client_message: "Please confirm whether the goods arrived on 3 May.", ...over,
});

test("draft_ops hold no send: a client message is only ever a live operation", () => {
  assert.ok(!WF.draft_ops.smokeball.some((op) => /Send|Portal/.test(op)));
  assert.deepEqual(WF.live_ops.smokeball, ["SendPortalMessageAsync"]);
  assert.deepEqual(Object.keys(CRONS).sort(), ["draft", "file-review", "intake"]);
});

test("crons read and draft, and never send a client message", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  await fileReview(ctx);
  await store.put("drafts", "draft-smith-1", pendingDraft());
  assert.deepEqual(await draft(ctx), { memos: 1, queued: 1 });
  assert.equal(portal().length, 0, "no portal message was sent by a cron");
  assert.equal(memos().length, 2, "one inventory memo and one draft memo");
});

test("a client message waits for approval, then runs once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  await store.put("drafts", "draft-smith-1", pendingDraft());
  await draft(ctx);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].acts[0].op, "SendPortalMessageAsync");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(portal().length, 1);
  assert.deepEqual(portal()[0].body, { contactId: C1, message: pendingDraft().client_message });
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("re-runs never double-file a memo or double-queue a message", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await fileReview(ctx);
  await store.put("drafts", "draft-smith-1", pendingDraft());
  await draft(ctx);
  const before = memos().length;
  await intake(ctx); await fileReview(ctx); await draft(ctx); await draft(ctx);
  assert.equal(memos().length, before, "no memo filed twice");
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "one approval queued");
});

test("file-review files an inventory only when the file count changes", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await fileReview(ctx), { inventories: 1 });
  assert.deepEqual(await fileReview(ctx), { inventories: 0 }, "same file count, nothing filed");
  files.push({ id: "55555555-6666-4777-8888-999999999999", name: "Defence notes.docx" });
  assert.deepEqual(await fileReview(ctx), { inventories: 1 });
  const tasks = hitsTo(/^\/tasks$/).filter((h) => h.method === "POST");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].body.staffId, STAFF);
  const m = await store.get<Matter>("matters", M1);
  assert.equal(m?.files_seen, 2);
});

test("bad ids are refused before any network call", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(smokeball.memo(ctx, "../x", "t", "x"), /bad matter id/);
  await assert.rejects(smokeball.files(ctx, "a b"), /bad matter id/);
  assert.throws(() => smokeball.clientMessage(M1, "../x", "hi", "s", "k"), /bad matter or contact id/);
  assert.equal(hits.length, 0);
});
