// Daily ad audit tests. Every request goes to a fake network: no test reaches a real ad account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pull, audit } from "../industries/agencies/workflows/marketing/adaudit/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/agencies/workflows/marketing/adaudit/workflow.json", "utf8")) as WorkflowRecord;
const SETTINGS: any = JSON.parse(fs.readFileSync("industries/agencies/workflows/marketing/adaudit/settings.example.json", "utf8"));
const ACCOUNT = "act_1234567890", PAUSE_ME = "111", KEEP = "222";
const NOW = new Date("2026-11-09T22:10:00Z");
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

const ROWS = [
  { campaign_id: PAUSE_ME, campaign_name: "Spring leads", spend: "200.00", impressions: "4000", clicks: "20", ctr: "0.5", frequency: "2.0", date_start: "2026-11-08", actions: [] },
  { campaign_id: KEEP, campaign_name: "Retargeting", spend: "50.00", impressions: "5000", clicks: "15", ctr: "0.3", frequency: "4.2", date_start: "2026-11-08", actions: [{ action_type: "lead", value: "3" }] },
];

beforeEach(() => {
  hits = [];
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
  const day = await store.get<any>("audits", "2026-11-08");
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

test("runtime: a cron cannot run a live operation as a draft", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "meta-ads", op: "Campaign.post.self", summary: "x" }), /not a draft operation/);
});
