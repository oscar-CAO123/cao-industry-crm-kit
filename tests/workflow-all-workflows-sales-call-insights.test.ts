// Call-insights workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { capture, tag, match } from "../industries/all/workflows/sales/call-insights/index.ts";
import { keyOf, type Settings } from "../industries/all/workflows/sales/call-insights/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/call-insights/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const T1 = "ffT0000001", T2 = "ffT0000002";
const K1 = keyOf(`fireflies:${T1}`), K2 = keyOf(`fireflies:${T2}`);
const PAIN = "We lost two jobs last month because the quote took a week.";
const OBJECTION = "Honestly the price is too high for us right now.";

const S: Settings = { max_calls_per_run: 20 };
const S_CRM: Settings = { ...S, match_crm: "hubspot" };

type Hit = { method: string; url: string; query?: string; body: any };
let hits: Hit[] = [];
let listed: any[] = [];
let graphqlError = false;

const transcripts: Record<string, any> = {
  [T1]: {
    id: T1, title: "Intro with Acme", date: 1762560000000, organizer_email: "Rep@Example.com.au",
    participants: ["rep@example.com.au", "Pat@Acme.example.com"], duration: 31,
    summary: { overview: "Pat runs two crews.", short_summary: "Discovery call.", action_items: "" },
    sentences: [{ speaker_name: "Pat", text: PAIN }, { speaker_name: "Rep", text: "What would change that?" }, { speaker_name: "Pat", text: OBJECTION }],
  },
  [T2]: {
    id: T2, title: "Follow up", date: "2026-11-07T03:00:00Z", organizer_email: "rep@example.com.au",
    participants: ["rep@example.com.au"], duration: 12, summary: {},
    sentences: [{ speaker_name: "Rep", text: "Thanks for your time today." }],
  },
};

function fake() {
  hits = []; graphqlError = false;
  listed = [{ id: T1 }, { id: T2 }, { id: "../bad" }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET";
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, url: u.origin + u.pathname, query: body?.query, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (u.hostname === "api.fireflies.ai") {
        if (graphqlError) return json({ errors: [{ message: "secret detail about a client" }] });
        if (/transcripts\(/.test(body.query)) return json({ data: { transcripts: listed } });
        if (/transcript\(/.test(body.query)) return json({ data: { transcript: transcripts[body.variables.id] ?? null } });
      }
      if (u.pathname === "/crm/v3/objects/contacts/search" || u.pathname.endsWith("/contacts/search")) {
        const v = body?.filterGroups?.[0]?.filters?.[0]?.value;
        return json({ results: v === "pat@acme.example.com" ? [{ id: "101" }] : [] });
      }
      return new Response("not faked: " + u.pathname, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { FIREFLIES_API_KEY: "ff-test-key-000000", HUBSPOT_ACCESS_TOKEN: "hs-test-token-000000" });
  delete process.env.KIT_ALLOW_WRITES;
});

test("runtime: no write operation and no live operation is reachable from this workflow", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "fireflies", op: "mutation.shareMeeting", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "hubspot", op: "crm-notes-3.post-/crm/v3/objects/notes_create", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "fireflies", op: "query.transcripts", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0, "nothing reached the network");
});

test("capture: stores each transcript once, reads only, and skips an unsafe id", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await capture(ctx), { added: 2 });
  assert.deepEqual(await capture(ctx), { added: 0 }, "re-runs never store a call twice");
  assert.ok(hits.length > 0 && hits.every((h) => /^\s*query /.test(h.query ?? "")), "every Fireflies call is a GraphQL query");
  assert.ok(hits.every((h) => h.method === "POST"), "no PUT, PATCH or DELETE");
  const calls = await store.list<any>("calls");
  assert.deepEqual(Object.keys(calls).sort(), [K1, K2].sort());
  assert.deepEqual(calls[K1].attendees, ["pat@acme.example.com"], "organizer left out, emails lower case");
  assert.equal(calls[K1].organizer, "rep@example.com.au");
  assert.equal(calls[K1].happened, new Date(1762560000000).toISOString(), "epoch milliseconds read as a date");
  assert.match(calls[K1].transcript, /Pat: We lost two jobs/);
  assert.equal((await store.get<{ since: string }>("state", "capture-fireflies"))!.since, calls[K2].happened);
});

test("capture: a GraphQL error is reported without its text", async () => {
  graphqlError = true;
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(capture(ctx), (e: Error) => /transcripts query failed/.test(e.message) && !/secret detail/.test(e.message));
});

test("tag: keeps only quotes that appear in the call, drops the rest, and tags each call once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await capture(ctx);
  await store.put("insights", K1, {
    pains: [{ quote: PAIN, speaker: "Pat", note: "Slow quotes cost jobs." }, { quote: "They said they will sign by Friday.", note: "Invented." }],
    objections: [{ quote: OBJECTION, speaker: "Pat", note: "Price is the blocker now." }],
    offers: [], buying_signals: [],
  });
  await store.put("insights", K2, { pains: [], objections: [], buying_signals: [] }); // missing a list: skipped
  assert.deepEqual(await tag(ctx), { tagged: 1, dropped: 1 });
  assert.deepEqual(await tag(ctx), { tagged: 0, dropped: 0 }, "a tagged call is never tagged again");
  const f = await store.get<any>("findings", K1);
  assert.equal(f.categories.pains.length, 1);
  assert.equal(f.categories.objections.length, 1);
  assert.equal(await store.get("findings", K2), undefined, "an invalid insight is not recorded");
  assert.equal(hits.filter((h) => h.body?.query?.includes("mutation")).length, 0);
});

test("match: looks up outside attendees as HubSpot contacts with reads only, and only when a CRM is set", async () => {
  const store = new MemoryStore();
  await capture(context(WF, S, store, NOW, () => {}));
  await store.put("insights", K1, { pains: [{ quote: PAIN, note: "Slow quotes." }], objections: [], offers: [], buying_signals: [] });
  await tag(context(WF, S, store, NOW, () => {}));

  const before = hits.length;
  assert.deepEqual(await match(context(WF, S, store, NOW, () => {})), { matched: 0, contacts: 0 });
  assert.equal(hits.length, before, "no CRM set: nothing is looked up");

  assert.deepEqual(await match(context(WF, S_CRM, store, NOW, () => {})), { matched: 1, contacts: 1 });
  const search = hits.filter((h) => h.url.endsWith("/contacts/search"));
  assert.equal(search.length, 1, "one lookup, for the one outside attendee");
  assert.equal(search[0].method, "POST");
  assert.equal(search[0].body.filterGroups[0].filters[0].value, "pat@acme.example.com");
  assert.deepEqual((await store.get<any>("calls", K1)).contact_ids, ["101"]);
  assert.deepEqual(await match(context(WF, S_CRM, store, NOW, () => {})), { matched: 0, contacts: 0 }, "a matched call is not looked up again");
});
