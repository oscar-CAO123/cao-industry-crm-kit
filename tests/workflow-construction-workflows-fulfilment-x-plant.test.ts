// Plant and equipment workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { registerWatch, costWatch } from "../industries/construction/workflows/fulfilment/x-plant/index.ts";
import { checkSettings, type Settings } from "../industries/construction/workflows/fulfilment/x-plant/types.ts";
import { render, TARGETS } from "../tools/deploy.ts";
import fs from "node:fs";

const DIR = "industries/construction/workflows/fulfilment/x-plant";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: Settings = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8"));
const S: Settings = { ...SETTINGS, owner_email: "owner@example.com.au", workshop_category_uuid: "cccccccc-dddd-4eee-8fff-000000000001", top_jobs: 10 };
const JOB1 = "11111111-2222-4333-8444-555555555551", JOB2 = "11111111-2222-4333-8444-555555555552", JOB3 = "11111111-2222-4333-8444-555555555553";
const NOW = new Date("2026-11-09T21:00:00Z");

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let tuPages: any[][] = [];
let tuTotalPages = 1;

const TU_ITEMS = [
  { id: 1001, name: "CAT 320  Excavator", serialNumber: "SN-320", brand: "CAT", model: "320", type: "Excavator", telematicsDevices: [{ id: "d1" }] },
  { id: 1002, name: "Hilux Ute 4x4", serialNumber: "SN-HX", brand: "Toyota", model: "Hilux", type: "Ute", telematicsDevices: [] },
  { id: 1003, name: "Compactor RD12", serialNumber: "SN-RD", brand: "Ammann", model: "RD12", type: "Compactor", telematicsDevices: [] },
];

function fake() {
  hits = []; tuPages = []; tuTotalPages = 1;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams.toString(), body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Trackunit: paged register
      if (p.endsWith("/v2/assets")) {
        const page = Number(u.searchParams.get("page") ?? 0);
        return json({ content: tuPages[page] ?? [], number: page, totalPages: tuTotalPages, numberOfElements: (tuPages[page] ?? []).length });
      }
      // ServiceM8: assets, workshop jobs and their materials
      if (p.endsWith("/asset.json") && m === "GET") return json([
        { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", name: "CAT 320 Excavator", asset_code: "A-1", active: 1 },
        { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000002", name: "Hilux Ute 4x4", asset_code: "A-2", active: 0 },
      ]);
      if (p.endsWith("/job.json") && m === "GET") {
        const f = u.searchParams.get("$filter") ?? "";
        if (!f.includes("category_uuid eq")) return json([]);
        return json([
          { uuid: JOB1, job_description: "Excavator hydraulic hose <script>alert(1)</script>", active: 1 },
          { uuid: JOB2, job_description: "Compactor drum bearing", active: 1 },
          { uuid: JOB3, job_description: "Old job", active: 0 },
        ]);
      }
      if (p.endsWith("/jobmaterial.json") && m === "GET") {
        const f = u.searchParams.get("$filter") ?? "";
        if (f.includes(JOB1)) return json([{ price: "120.50", quantity: "2", active: 1 }, { price: "30", quantity: "1", active: 1 }]);
        if (f.includes(JOB2)) return json([{ price: "500", quantity: "1", active: 1 }]);
        return json([]);
      }
      if (p.endsWith("/platform_service_email") && m === "POST") return json({ errorCode: 0 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const trackunitPage = (n: number) => [TU_ITEMS[n]];
const sends = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/platform_service_email"));
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  tuPages = [TU_ITEMS];
  Object.assign(process.env, { TRACKUNIT_ACCESS_TOKEN: "tu", SERVICEM8_API_KEY: "s8", SERVICEM8_ADDON_ACCESS_TOKEN: "s8-oauth-test", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot send from a draft and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "servicem8", op: "messaging-api.send_email", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "servicem8", op: "servicem8-api.listAssets", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "trackunit", op: "assets.deleteAsset_v2", summary: "x" }), /not a draft operation/);
});

test("register-watch: reads both registers, matches by name, and writes nothing to either platform", async () => {
  tuPages = [TU_ITEMS];
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await registerWatch(ctx), { plant: 3, matched: 1, unmatched: 2 });
  assert.equal(writes().length, 0, "reads only");
  const rows = Object.values(await store.list<any>("plant"));
  assert.equal(rows.length, 3);
  const exc = rows.find((r) => r.trackunit_id === "1001");
  assert.equal(exc.in_servicem8, true);
  assert.equal(exc.servicem8_uuid, "aaaaaaaa-bbbb-4ccc-8ddd-000000000001");
  assert.equal(exc.telematics_devices, 1);
  assert.equal(rows.find((r) => r.trackunit_id === "1002").in_servicem8, false, "inactive ServiceM8 asset does not match");
});

test("register-watch: pages through the Trackunit register until the last page", async () => {
  tuPages = [[TU_ITEMS[0], TU_ITEMS[1]], [TU_ITEMS[2]]];
  tuTotalPages = 2;
  const ctx = context(WF, { ...S, trackunit_page_size: 2 }, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await registerWatch(ctx), { plant: 3, matched: 1, unmatched: 2 });
  const pages = hits.filter((h) => h.path.endsWith("/v2/assets")).map((h) => new URLSearchParams(h.query).get("page"));
  assert.deepEqual(pages, ["0", "1"], "stops after totalPages");
});

test("cost-watch: totals parts per workshop job, queues one summary for approval, and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await costWatch(ctx), { jobs: 2, queued: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const costs = Object.values(await store.list<any>("job-costs")).sort((a, b) => b.parts_ex_gst - a.parts_ex_gst);
  assert.deepEqual(costs.map((c) => [c.job_uuid, c.parts_ex_gst]), [[JOB2, 500], [JOB1, 271]]);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.deepEqual(ap.acts.map((a) => a.op), ["messaging-api.send_email"]);
  assert.match(ap.summary, /owner@example\.com\.au/);
  assert.match(ap.summary, /\$771\.00 parts/);
});

test("cost-watch: a second run the same day queues nothing new; approval sends once to the owner", async () => {
  const store = new MemoryStore();
  await costWatch(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await costWatch(context(WF, S, store, NOW, () => {})), { jobs: 2, queued: 1 });
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.equal(sends()[0].body.to, "owner@example.com.au");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already done/);
  assert.equal(sends().length, 1, "sent once");
});

test("cost-watch: the job description from ServiceM8 is escaped in the summary email", async () => {
  const store = new MemoryStore();
  await costWatch(context(WF, S, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  const html = sends()[0].body.htmlBody as string;
  assert.ok(!html.includes("<script>"), "no raw script tag");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("cost-watch: with no workshop category set it reads no jobs and queues nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await costWatch(context(WF, { ...S, workshop_category_uuid: "" }, store, NOW, () => {})), { jobs: 0, queued: 0 });
  assert.equal(hits.filter((h) => h.path.endsWith("/job.json")).length, 0);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("settings: a bad owner email, category or page size is refused before any call", () => {
  assert.throws(() => checkSettings({ ...S, owner_email: "not-an-email" }), /owner_email/);
  assert.throws(() => checkSettings({ ...S, workshop_category_uuid: "x; DROP" }), /uuid/);
  assert.throws(() => checkSettings({ ...S, trackunit_page_size: 500 }), /1 to 200/);
  assert.throws(() => checkSettings({ ...S, family: "other" as any }), /plant-register/);
  checkSettings(S);
});

test("deploy: every target renders both crons, with key names and no key values", () => {
  for (const t of TARGETS) {
    const files = render(DIR, S, t);
    const all = Object.values(files).join("\n");
    for (const c of WF.crons) assert.ok(all.includes(c.name) || all.includes(c.schedule), `${t} has ${c.name}`);
    assert.ok(!/tu-|s8-|Bearer [A-Za-z0-9]{8}/.test(all.replace(/SERVICEM8|TRACKUNIT|kit|Bearer \$|Bearer \\\$|Bearer ' \|\||Bearer \${/g, "")), `${t} carries no key values`);
  }
});

test("every operation the workflow names is mapped in the kit", async () => {
  const { describe } = await import("../core/sdk/call.ts");
  for (const [platform, list] of Object.entries({ ...WF.draft_ops, ...WF.live_ops })) for (const op of list) assert.ok(describe(platform, op), `${platform} ${op}`);
  assert.ok(WF.draft_ops.trackunit.includes("assets.getAssets_v2") && WF.live_ops.servicem8.includes("messaging-api.send_email"));
});
