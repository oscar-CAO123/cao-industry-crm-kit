// File-notes workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import fs from "node:fs";
import { intake, draft } from "../industries/financial-services/workflows/compliance-safety/filenotes/index.ts";

const FOLDER = "industries/financial-services/workflows/compliance-safety/filenotes";
const WF = JSON.parse(fs.readFileSync(`${FOLDER}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Advice", adviser: "A. Adviser", lookback_days: 2, max_per_run: 20 };
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { path: string; query: string; variables: any };
let hits: Hit[] = [];
let shareFails = 0;

const LIST = [
  { id: "ff-meet-1", title: "Renewal review, Smith family", dateString: "2026-11-08T23:00:00.000Z", organizer_email: "adviser@example.com" },
  { id: "ff-meet-2", title: "Quote walk-through", dateString: "2026-11-08T22:00:00.000Z", organizer_email: "adviser@example.com" },
  { id: "bad id; drop table", title: "Injected id", dateString: "2026-11-08T21:00:00.000Z" },
];
const TRANSCRIPTS: Record<string, any> = {
  "ff-meet-1": {
    id: "ff-meet-1", title: "Renewal review, Smith family", dateString: "2026-11-08T23:00:00.000Z", organizer_email: "adviser@example.com",
    meeting_attendees: [{ email: "client@example.com", name: "Pat Smith" }, null],
    summary: { overview: "Discussed the home policy renewal and the higher excess.", action_items: "- Send the renewal comparison\n- Confirm the sum insured", keywords: ["renewal"] },
    transcript_url: "https://app.fireflies.ai/view/ff-meet-1",
  },
  "ff-meet-2": {
    id: "ff-meet-2", title: "Quote walk-through", dateString: "2026-11-08T22:00:00.000Z", organizer_email: "adviser@example.com",
    meeting_attendees: [], summary: null, transcript_url: null,
  },
};

function fake() {
  hits = []; shareFails = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      const body = init?.body ? JSON.parse(init.body) : {};
      const query = String(body.query ?? "");
      hits.push({ path: u.pathname, query, variables: body.variables ?? {} });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.fireflies.ai") return new Response("wrong host", { status: 404 });
      if (/shareMeeting|revokeSharedMeetingAccess/.test(query)) {
        if (shareFails-- > 0) return json({ errors: [{ message: "share refused" }] }, 500);
        return json({ data: { shareMeeting: { success: true, message: "ok" } } });
      }
      if (/transcripts\(/.test(query)) return json({ data: { transcripts: LIST } });
      if (/transcript\(/.test(query)) return json({ data: { transcript: TRANSCRIPTS[body.variables?.id] ?? null } });
      return json({ errors: [{ message: "not faked" }] });
    }) as any,
  });
}
const reads = () => hits.filter((h) => !/^\s*mutation/.test(h.query));
const writes = () => hits.filter((h) => /^\s*mutation/.test(h.query));

beforeEach(() => {
  fake();
  Object.assign(process.env, { FIREFLIES_API_KEY: "ff-test-key", KIT_ALLOW_WRITES: "1" });
});

test("every operation the workflow names exists in the kit's Fireflies map", () => {
  for (const op of [...WF.draft_ops.fireflies, ...WF.live_ops.fireflies]) assert.doesNotThrow(() => describe("fireflies", op), op);
});

test("crons only read: intake and draft send no mutation, and nothing is shared", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await draft(ctx), { drafted: 1, waiting: 1 });
  assert.equal(writes().length, 0, "no mutation from a cron");
  assert.ok(reads().length >= 3, "the crons read Fireflies");
});

test("a cron cannot run a live operation, and a live one only queues until approved", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "fireflies", op: "mutation.shareMeeting", input: { params: { input: { meeting_id: "ff-meet-1", emails: ["client@example.com"] } } }, summary: "share" }), /not a draft operation/);
  const id = await ctx.queue({ platform: "fireflies", op: "mutation.shareMeeting", summary: "share Smith renewal transcript with client", key: "share:ff-meet-1",
    input: { params: { input: { meeting_id: "ff-meet-1", emails: ["client@example.com"], expiry_days: 7 } }, select: "success message" } });
  assert.equal(writes().length, 0, "queued, not run");
  const ap = await store.get<Approval>("approvals", id);
  assert.equal(ap?.status, "pending");
  const again = await ctx.queue({ platform: "fireflies", op: "mutation.shareMeeting", summary: "share", key: "share:ff-meet-1",
    input: { params: { input: { meeting_id: "ff-meet-1", emails: ["client@example.com"], expiry_days: 7 } }, select: "success message" } });
  assert.equal(again, id, "queuing the same share twice gives one approval");
  const done = await approve(WF, store, id, "adviser", NOW);
  assert.equal(done.status, "done");
  assert.equal(writes().length, 1, "the approved share ran once");
  await assert.rejects(approve(WF, store, id, "adviser", NOW), /already done/);
});

test("a failed share stays failed and retries only on a person's approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  const id = await ctx.queue({ platform: "fireflies", op: "mutation.shareMeeting", summary: "share", key: "share:ff-meet-2",
    input: { params: { input: { meeting_id: "ff-meet-2", emails: ["client@example.com"] } }, select: "success message" } });
  shareFails = 1;
  // A 500 may have been processed by the app: the approval waits for a person to check, and nothing resends on its own.
  assert.equal((await approve(WF, store, id, "adviser", NOW)).status, "needs-check");
  await assert.rejects(approve(WF, store, id, "adviser", NOW), /needs a check/, "approving again without a confirmation sends nothing");
  assert.equal((await approve(WF, store, id, "adviser", NOW, "retry")).status, "done");
  assert.equal(writes().length, 2);
});

test("a draft note is stored as a draft from the Fireflies summary, and is never filed", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const note = await store.get<any>("notes", "ff-meet-1");
  assert.equal(note.status, "draft");
  assert.match(note.body, /^DRAFT FILE NOTE\. Not filed/);
  assert.match(note.body, /Discussed the home policy renewal/);
  assert.match(note.body, /Send the renewal comparison/);
  assert.match(note.body, /Pat Smith/);
  assert.match(note.body, /Adviser: A\. Adviser/);
  assert.equal(writes().length, 0);
});

test("re-runs never draft or list a meeting twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.deepEqual(await draft(ctx), { drafted: 0, waiting: 1 });
  assert.equal(Object.keys(await store.list("notes")).length, 1);
});

test("a meeting with no summary is retried, then skipped after six checks", async () => {
  const store = new MemoryStore();
  let ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  for (let i = 0; i < 5; i++) await draft(ctx);
  assert.equal((await store.get<any>("meetings", "ff-meet-2")).status, "new");
  await draft(ctx);
  const m = await store.get<any>("meetings", "ff-meet-2");
  assert.equal(m.status, "skipped");
  assert.equal(m.reason, "no summary after several checks");
  assert.equal(await store.get("notes", "ff-meet-2"), undefined);
});

test("ids from outside are checked before they reach a call: a bad id is never read", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(Object.keys(await store.list("meetings")).sort(), ["ff-meet-1", "ff-meet-2"]);
  assert.ok(!hits.some((h) => h.query.includes("drop table") || JSON.stringify(h.variables).includes("drop table")));
});
