// Client programs workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { programDraft, checkIn, progressSummary, CRONS } from "../industries/fitness-beauty/workflows/fulfilment/client-programs/index.ts";
import fs from "node:fs";

const DIR = "industries/fitness-beauty/workflows/fulfilment/client-programs";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BASE = "app" + "A".repeat(14);
const MAILBOX = "coach@example.com";
const NOW = new Date("2026-11-08T00:00:00Z");
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString().slice(0, 10);
const rec = (ch: string) => "rec" + ch.repeat(14);
const ARI = rec("A"), SAM = rec("B"), KIM = rec("C");

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let state: any;

const SETTINGS = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const S: any = {
  ...SETTINGS,
  airtable: { ...SETTINGS.airtable, base_id: BASE },
  check_in: { after_days: 7, subject: "Checking in", body: "Hi {name},\n\nHow is the week going?\n\nThanks" },
};

function fake() {
  hits = [];
  state = {
    Clients: [
      { id: ARI, fields: { Name: "Ari Patel", Email: "ari@example.com", Goal: "Strength for a rowing season", Status: "Intake complete" } },
      { id: SAM, fields: { Name: "Sam Lee", Email: "sam@example.com", Goal: "Fat loss", Status: "Active" } },
      { id: KIM, fields: { Name: "Kim Ong", Email: "kim@example.com", Goal: "Habit building", Status: "Active" } },
    ],
    Sessions: [
      { id: rec("D"), fields: { Client: [KIM], Date: DAYS_AGO(2), Notes: "Upper body" } },
      { id: rec("E"), fields: { Client: [SAM], Date: DAYS_AGO(10), Notes: "Intervals" } },
    ],
    Programs: [], Progress: [], drafts: 0, sends: [],
  };
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 3600 });
      // Airtable: /v0/<base>/<table>[/<record>]
      if (p.startsWith(`/v0/${BASE}/`)) {
        const [, , , table, id] = p.split("/");
        if (m === "GET") return json({ records: state[table] ?? [] });
        if (m === "POST") {
          const row = { id: "rec" + String(state[table].length + 1).padStart(14, "0"), fields: body.records[0].fields };
          state[table].push(row);
          return json({ records: [{ id: row.id }] });
        }
        if (m === "PATCH") {
          const row = state[table].find((x: any) => x.id === id);
          if (!row) return new Response("{}", { status: 404 });
          Object.assign(row.fields, body.fields);
          return json({ id: row.id, fields: row.fields });
        }
      }
      // Gmail
      if (m === "POST" && /\/drafts$/.test(p)) { state.drafts++; return json({ id: `draft${state.drafts}`, message: { id: `m${state.drafts}` } }); }
      if (m === "POST" && /\/drafts\/send$/.test(p)) { state.sends.push(body.id); return json({ id: body.id }); }
      if (m === "POST" && /\/messages\/send$/.test(p)) { state.sends.push("message"); return json({ id: "m" }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET" && !/\/token$/.test(h.path));
const sends = () => hits.filter((h) => /\/(drafts\/send|messages\/send)$/.test(h.path));

beforeEach(async () => {
  fake();
  setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, {
    AIRTABLE_ACCESS_TOKEN: "at", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", GOOGLE_MAILBOX: MAILBOX, KIT_ALLOW_WRITES: "1",
  });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "airtable", op: "docs.post_baseId_tableIdOrName", summary: "x" }), /not a live operation/);
});

test("program-draft: a matching template fills one program row, once, and the client moves on", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await programDraft(ctx), { drafted: 1, needs_coach: 0 });
  assert.equal(state.Programs.length, 1);
  assert.deepEqual(state.Programs[0].fields.Client, [ARI]);
  assert.equal(state.Clients[0].fields.Status, "Program drafted");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.deepEqual(await programDraft(ctx), { drafted: 0, needs_coach: 0 }, "a re-run never drafts a second program");
  assert.equal(state.Programs.length, 1);
});

test("check-in: one draft per quiet client, the send is queued, and a re-run in the same window queues nothing new", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await checkIn(ctx), { drafted: 1 }, "only Sam: Kim had a session two days ago, Ari is not active");
  assert.equal(state.drafts, 1);
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const raw = hits.find((h) => /\/drafts$/.test(h.path))!.body.message.raw;
  const mail = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mail, /To: sam@example.com/);
  assert.match(mail, /Hi Sam,/);
  await checkIn(ctx);
  assert.equal(state.drafts, 1, "re-runs never draft twice");
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.deepEqual(state.sends, ["draft1"]);
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("progress-summary: one row per active client per week, counting the sessions logged", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await progressSummary(ctx), { written: 2 });
  const byClient = Object.fromEntries(state.Progress.map((r: any) => [r.fields.Client[0], r.fields.Summary]));
  assert.equal(byClient[KIM], "1 session logged in the last 7 days. 1 logged in total.");
  assert.equal(byClient[SAM], "0 sessions logged in the last 7 days. 1 logged in total.");
  assert.deepEqual(await progressSummary(ctx), { written: 0 });
  assert.equal(state.Progress.length, 2);
  assert.equal(sends().length, 0);
});

test("all three crons run with no send, and a bad base id or record id never reaches a URL", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  for (const run of Object.values(CRONS)) await run(ctx);
  assert.equal(sends().length, 0, "no cron sends");

  fake();
  await assert.rejects(programDraft(context(WF, { ...S, airtable: { ...S.airtable, base_id: "https://evil.example" } }, new MemoryStore(), NOW, () => {})), /base_id/);
  state.Clients.push({ id: "../x", fields: { Name: "Bad", Status: "Intake complete", Goal: "Strength" } });
  assert.deepEqual(await programDraft(context(WF, S, new MemoryStore(), NOW, () => {})), { drafted: 1, needs_coach: 0 });
  assert.equal(state.Programs.length, 1, "the malformed row was skipped");
  assert.ok(!hits.some((h) => h.path.includes("..")), "no path built from the malformed id");
});
