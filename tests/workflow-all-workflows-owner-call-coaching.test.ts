// Call-coaching workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { capture, coach, validScore } from "../industries/all/workflows/owner/call-coaching/index.ts";
import type { Score } from "../industries/all/workflows/owner/call-coaching/types.ts";
import { main } from "../tools/workflow.ts";

const DIR = "industries/all/workflows/owner/call-coaching";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: any = {
  business_name: "Test Services", intake: ["fireflies", "gohighlevel"], locationId: "LOC0000001",
  reps: { "sam@example.com": "REPCONTACT01" }, coach_from: "coaching@example.com", max_calls_per_run: 10,
};
const TRANSCRIPT = {
  id: "ff-1", title: "Discovery call with Ari", date: Date.parse("2026-11-07T23:00:00Z"), organizer_email: "Sam@example.com", duration: 14,
  summary: { overview: "Discovery call", short_summary: "Ari wants a quote", action_items: "Send pricing\nBook a site visit" },
  sentences: [{ speaker_name: "Sam", text: "Thanks for calling, what do you need?" }, { speaker_name: "Ari", text: "A blocked drain quote." }],
};
const GOOD: Score = {
  total: 72, parts: { rapport: 16, discovery: 14, objections: 12, closing: 15, next_step: 15 },
  coaching: ["Ask <b>budget</b> before quoting.", "Confirm the next step in writing."], next_step: "Send the pricing sheet", scored: NOW.toISOString(),
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Fireflies (GraphQL): every call is a query.
      if (p === "/graphql") {
        const q: string = body?.query ?? "";
        if (/\btranscripts\(/.test(q)) return json({ data: { transcripts: [{ id: TRANSCRIPT.id, date: TRANSCRIPT.date, organizer_email: TRANSCRIPT.organizer_email, duration: TRANSCRIPT.duration }] } });
        if (/\btranscript\(/.test(q)) return json({ data: { transcript: TRANSCRIPT } });
        return new Response("not faked", { status: 404 });
      }
      // GoHighLevel.
      if (p === "/voice-ai/dashboard/call-logs") return json({ total: 1, page: 1, pageSize: 10, callLogs: [{
        id: "call-1", contactId: "CONTACT0001", agentId: "agent-1", createdAt: "2026-11-07T22:00:00Z", duration: 300,
        trialCall: false, executedCallActions: [], summary: "Asked for a quote", transcript: "Caller: I need a quote" }] });
      if (/^\/contacts\/[^/]+\/notes$/.test(p) && m === "POST") return json({ note: { id: "n1" } });
      if (p === "/conversations/messages" && m === "POST") return json({ messageId: "m1" });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => h.method === "POST" && h.path === "/conversations/messages");
const notes = () => hits.filter((h) => h.method === "POST" && /\/notes$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIREFLIES_API_KEY: "ff-test", GHL_ACCESS_TOKEN: "ghl-test", KIT_ALLOW_WRITES: "1" });
});

test("every draft and queued operation exists in the kit's platform maps", () => {
  for (const [platform, ids] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) {
    const ops = JSON.parse(fs.readFileSync(`core/sdk/platforms/${platform}/ops.json`, "utf8")) as { id: string }[];
    for (const id of ids) assert.ok(ops.some((o) => o.id === id), `${platform} ${id} is not in ops.json`);
  }
});

test("capture reads both platforms and stores each call once", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await capture(ctx()), { added: 2 });
  assert.deepEqual(await capture(ctx()), { added: 0 }, "a second run stores nothing new");
  assert.equal(Object.keys(await store.list("calls")).length, 2);
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("coach drafts the note and queues the rep email, and sends nothing", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await capture(ctx());
  await store.put("scores", "fireflies:ff-1", GOOD);
  await store.put("scores", "gohighlevel:call-1", GOOD);
  assert.deepEqual(await coach(ctx()), { noted: 1, queued: 1 });
  assert.equal(notes().length, 1, "one internal note on the GoHighLevel contact");
  assert.equal(notes()[0].path, "/contacts/CONTACT0001/notes");
  assert.equal(sends().length, 0, "the rep email waits for approval");
  const pending = await main(["approvals", DIR], store) as any[];
  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /sam@example\.com/);
});

test("the rep email goes only when approved, escaped, and re-runs never queue or repeat", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await capture(ctx());
  await store.put("scores", "fireflies:ff-1", GOOD);
  await store.put("scores", "gohighlevel:call-1", GOOD);
  await coach(ctx());
  await coach(ctx());
  assert.equal(notes().length, 1, "a second coach run never repeats the note");
  assert.equal(Object.keys(await store.list("approvals")).length, 1, "a second coach run never queues twice");
  const [pending] = await main(["approvals", DIR], store) as any[];
  const ap = await approve(WF, store, pending.id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  const sent = sends()[0].body;
  assert.equal(sent.type, "Email");
  assert.equal(sent.contactId, "REPCONTACT01");
  assert.equal(sent.emailFrom, "coaching@example.com");
  assert.match(sent.html, /&lt;b&gt;budget&lt;\/b&gt;/, "coaching text is escaped in the email");
  assert.doesNotMatch(sent.html, /<b>budget/);
});

test("a cron cannot draft a live operation or queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "gohighlevel", op: "conversations.send-a-new-message", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "fireflies", op: "query.transcripts", summary: "x" }), /not a live operation/);
  assert.equal(sends().length, 0);
});

test("the SDK gate still blocks the note when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await store.put("calls", "gohighlevel:call-1", { key: "gohighlevel:call-1", platform: "gohighlevel", ref: "call-1", title: "Voice call", happened: NOW.toISOString(), contactId: "CONTACT0001", summary: "", next_steps: [], transcript: "x", captured: NOW.toISOString() });
  await store.put("scores", "gohighlevel:call-1", GOOD);
  await assert.rejects(coach(ctx()), WriteBlocked);
  assert.equal(notes().length, 0);
});

test("invalid scores and unsafe contact ids are refused before any write", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, SETTINGS, store, NOW, () => {});
  await capture(ctx());
  await store.put("scores", "fireflies:ff-1", { ...GOOD, total: 150 });
  await store.put("scores", "gohighlevel:call-1", GOOD);
  const call = (await store.get<any>("calls", "gohighlevel:call-1"));
  await store.put("calls", "gohighlevel:call-1", { ...call, contactId: "../../etc" });
  assert.deepEqual(await coach(ctx()), { noted: 0, queued: 0 });
  assert.equal(notes().length, 0);
  assert.equal(sends().length, 0);
  assert.equal(validScore({ ...GOOD, coaching: [] }), false);
  assert.equal(validScore({ ...GOOD, parts: { rapport: 21 } }), false);
  assert.equal(validScore(GOOD), true);
});
