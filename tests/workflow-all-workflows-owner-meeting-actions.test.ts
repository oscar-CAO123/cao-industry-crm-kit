// Meeting-actions workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { capture, draft } from "../industries/all/workflows/owner/meeting-actions/index.ts";
import type { Meeting, Settings } from "../industries/all/workflows/owner/meeting-actions/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/owner/meeting-actions/workflow.json", "utf8")) as WorkflowRecord;
const FF_ID = "01HFFMEETING1", NOTE = "not_AAAAAAAAAAAAAA";
const RECAP = ["team@example.com"];
const NOW = new Date("2026-11-08T00:00:00Z");
const SET: Settings = { business_name: "Test Co", meeting_sources: ["fireflies", "granola"], recap_to: RECAP, recap_expiry_days: 14, lookback_days: 14, max_actions: 20 };

type Hit = { method: string; host: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.hostname, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname === "api.fireflies.ai") {
        const q: string = body?.query ?? "";
        if (q.startsWith("mutation")) return json({ data: { shareMeeting: { success: true, message: "shared" } } });
        return json({ data: { transcripts: [{ id: FF_ID, title: "Client inquiry call", dateString: "2026-11-07T23:00:00.000Z",
          summary: { overview: "Quote for a re-piping job", short_summary: "", action_items: "- Send the quote by Friday\n- Book a site visit" },
          meeting_attendees: [{ displayName: "Sam Lee", name: "Sam" }] }] } });
      }
      if (u.hostname === "public-api.granola.ai") {
        if (p === "/v1/notes") return json({ notes: [{ id: NOTE, object: "note", title: "Site walk", created_at: "2026-11-07T01:00:00Z", updated_at: "2026-11-07T02:00:00Z" }], hasMore: false, cursor: null });
        if (p === `/v1/notes/${NOTE}`) return json({ id: NOTE, object: "note", title: "Site walk", created_at: "2026-11-07T01:00:00Z", updated_at: "2026-11-07T02:00:00Z",
          summary_markdown: "We walked the site and agreed the scope.", attendees: [{ name: "Ari Patel", email: "ari@example.com" }] });
        if (p === `/v1/notes/${NOTE}/transcript`) return json({ transcript: [{ speaker: { source: "microphone" }, text: "Can you do the tiles next week?", start_time: "2026-11-07T01:01:00Z", end_time: "2026-11-07T01:01:05Z" }], hasMore: false, cursor: null });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const approvals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals"));
const shares = () => hits.filter((h) => h.host === "api.fireflies.ai" && String(h.body?.query ?? "").startsWith("mutation"));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIREFLIES_API_KEY: "ff-test", GRANOLA_API_KEY: "gr-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a read", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "fireflies", op: "mutation.shareMeeting", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "granola", op: "get /v1/notes", summary: "x" }), /not a live operation/);
});

test("crons read and draft, never send: the recap share is only queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await capture(ctx), { added: 2, refreshed: 0 });
  const d = await draft(ctx) as any;
  assert.equal(d.drafted, 1, "the Fireflies meeting has its own action list");
  assert.equal(d.needs_notes, 1, "the Granola note has no action list yet");
  assert.equal(shares().length, 0, "no share request leaves during a cron run");
  const pending = await approvals(store);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].acts[0].op, "mutation.shareMeeting");
});

test("a queued share runs once, only after approval, and re-runs never queue it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx); await draft(ctx);
  await capture(ctx); await draft(ctx);
  const [ap0] = await approvals(store);
  assert.equal((await approvals(store)).length, 1, "re-runs never queue the same share twice");
  assert.equal(shares().length, 0);
  const done = await approve(WF, store, ap0.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(shares().length, 1);
  const vars = shares()[0].body.variables.input;
  assert.equal(vars.meeting_id, FF_ID);
  assert.deepEqual(vars.emails, RECAP);
  assert.equal(vars.expiry_days, 14);
});

test("a Granola meeting waits for the agent's actions, then drafts with overdue counted", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx); await draft(ctx);
  const granolaKey = Object.values(await store.list<Meeting>("meetings")).find((m) => m.platform === "granola")!.key;
  assert.equal((await store.get<Meeting>("meetings", granolaKey))!.status, "needs-notes");
  await store.put("proposals", granolaKey, { summary: "Site walk agreed.", actions: [
    { text: "Quote the tiles", owner: "Ari Patel", due: "2026-11-01" }, { text: "Confirm the site date" }] });
  const d = await draft(ctx) as any;
  assert.equal(d.drafted, 1);
  assert.equal(d.queued, 0, "Granola has no share operation: nothing is queued for it");
  const m = await store.get<Meeting>("meetings", granolaKey);
  assert.equal(m!.status, "drafted");
  assert.equal(m!.actions!.length, 2);
  assert.equal(m!.overdue, 1, "a due date before today is overdue");
  assert.equal(shares().length, 0);
});

test("a proposal that breaks the rules is refused and the meeting stays needs-notes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx); await draft(ctx);
  const granolaKey = Object.values(await store.list<Meeting>("meetings")).find((m) => m.platform === "granola")!.key;
  await store.put("proposals", granolaKey, { summary: "x", actions: [{ text: "y".repeat(400) }] });
  await draft(ctx);
  const m = await store.get<Meeting>("meetings", granolaKey);
  assert.equal(m!.status, "needs-notes");
  assert.match(m!.reason ?? "", /proposal not usable: each action needs text of 1 to 300 characters/);
});

test("an unchanged meeting is not stored again on the next capture", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx);
  assert.deepEqual(await capture(ctx), { added: 0, refreshed: 0 });
});

test("the write gate still blocks an approved share when the deploy does not allow writes", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await capture(ctx); await draft(ctx);
  const [ap] = await approvals(store);
  process.env.KIT_ALLOW_WRITES = "0";
  const failed = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /write blocked/);
  assert.equal(shares().length, 0);
});
