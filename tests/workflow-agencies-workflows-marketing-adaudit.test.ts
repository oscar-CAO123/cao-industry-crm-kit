// Daily ad audit tests. Every request goes to a fake network: no test reaches a real ad account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, audit, yesterdayIn } from "../industries/agencies/workflows/marketing/adaudit/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agencies/workflows/marketing/adaudit/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = JSON.parse(fs.readFileSync("industries/agencies/workflows/marketing/adaudit/settings.example.json", "utf8"));
const ACCOUNT = "act_1234567890", PAUSE_ME = "111", KEEP = "222";
const NOW = new Date("2026-11-09T22:10:00Z");          // Sydney 10 Nov 09:10: yesterday is 9 Nov
const TOMORROW = new Date("2026-11-10T22:10:00Z");     // yesterday is 10 Nov, so 9 Nov data is stale
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

// PAUSE_ME reports an explicit zero lead row, so it is a known zero result and may be paused.
const BASE_ROWS = [
  { campaign_id: PAUSE_ME, campaign_name: "Spring leads", spend: "200.00", impressions: "4000", clicks: "20", ctr: "0.5", frequency: "2.0", date_start: "2026-11-09", actions: [{ action_type: "lead", value: "0" }] },
  { campaign_id: KEEP, campaign_name: "Retargeting", spend: "50.00", impressions: "5000", clicks: "15", ctr: "0.3", frequency: "4.2", date_start: "2026-11-09", actions: [{ action_type: "lead", value: "3" }] },
];
let ROWS: any[] = structuredClone(BASE_ROWS);

beforeEach(() => {
  hits = [];
  ROWS = structuredClone(BASE_ROWS);
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { META_ADS_TOKEN: "meta-test", KIT_ALLOW_WRITES: "1" });
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/${ACCOUNT}/insights`) && m === "GET") return json({ data: ROWS });
      if (p.endsWith(`/${PAUSE_ME}`) && m === "POST") return json({ success: true });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
});

const writes = () => hits.filter((h) => h.method !== "GET");

test("pull and audit only read: no write reaches the ad account", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  await audit(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(writes().length, 0);
  assert.ok(hits.some((h) => h.method === "GET" && h.path.endsWith(`/${ACCOUNT}/insights`)));
});

test("audit stores findings and queues the pause only for approval", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  const res: any = await audit(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(res.queued, 1);
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1);
  assert.match(pending[0].acts[0].summary, /pause/);
  assert.equal(writes().length, 0, "a queued pause must not reach Meta before approval");
  const day = await store.get<any>("audits", "2026-11-09");
  assert.ok(day.findings.some((f: any) => f.kind === "spend-without-results" && f.campaign_id === PAUSE_ME));
  assert.ok(day.findings.some((f: any) => f.kind === "frequency" && f.campaign_id === KEEP));
});

test("re-running the audit never queues the same pause twice", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  await audit(context(WF, SETTINGS, store, NOW, () => {}));
  await audit(context(WF, SETTINGS, store, NOW, () => {}));
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1);
});

test("an approved pause runs once against the campaign with status PAUSED", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  await audit(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, "POST");
  assert.ok(w[0].path.endsWith(`/${PAUSE_ME}`));
  assert.equal(w[0].body.status, "PAUSED");
});

test("an audit on a stale snapshot stops: nothing is queued and the stop is recorded", async () => {
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));          // delivers 9 Nov
  const res: any = await audit(context(WF, SETTINGS, store, TOMORROW, () => {}));   // expects 10 Nov
  assert.match(res.stopped, /not 2026-11-10/);
  assert.equal(res.queued, 0);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0, "no pause is queued on older data");
  const day = await store.get<any>("audits", "2026-11-10");
  assert.match(day.stopped, /did not finish/);
});

test("a campaign with no matching action row is unknown, not zero, so it is not paused", async () => {
  ROWS[0].actions = [];                                              // PAUSE_ME: no lead row at all
  const store = new MemoryStore();
  await pull(context(WF, SETTINGS, store, NOW, () => {}));
  const res: any = await audit(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(res.queued, 0);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
  assert.equal((await store.get<any>("snapshots", `${ACCOUNT}:${PAUSE_ME}:2026-11-09`)).results, null);
});

test("an empty result_action_types refuses to run", async () => {
  const store = new MemoryStore();
  const bad = { ...SETTINGS, result_action_types: [] };
  await assert.rejects(pull(context(WF, bad, store, NOW, () => {})), /result_action_types is empty/);
  await assert.rejects(audit(context(WF, bad, store, NOW, () => {})), /result_action_types is empty/);
  assert.equal(hits.length, 0, "no request is made");
});

test("a missing timezone refuses to run the audit", async () => {
  const { timezone: _drop, ...noZone } = SETTINGS;
  await assert.rejects(audit(context(WF, noZone, new MemoryStore(), NOW, () => {})), /timezone is missing/);
});

test("yesterday is a calendar day in the account's timezone", () => {
  assert.equal(yesterdayIn(NOW, "Australia/Sydney"), "2026-11-09");
  assert.equal(yesterdayIn(NOW, "UTC"), "2026-11-08");
});

test("runtime: a cron cannot run a live operation as a draft", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Campaign.post.self", summary: "x" }), /not a draft operation/);
});
