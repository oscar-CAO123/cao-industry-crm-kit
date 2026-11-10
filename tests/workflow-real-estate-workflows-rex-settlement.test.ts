// Settlement workflow, Rex side (contracts). Every request goes to a fake network: no test reaches a real Rex account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { register, check, reminders } from "../industries/real-estate/workflows/fulfilment/settlement/index.ts";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/fulfilment/settlement/workflow.json", "utf8")) as WorkflowRecord;
const REXOPS = JSON.parse(fs.readFileSync("core/sdk/platforms/rex/ops.json", "utf8")) as { id: string; kind: string }[];
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { platform: "rex", remind_days: 3, rex: { contract_statuses: ["Unconditional", "accepted"] } };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [], rows: any[] = [], page: (o: number) => any;

beforeEach(() => {
  hits = [];
  rows = [
    { id: 1, contract_status: "unconditional", date_expec_settlement: "2026-11-11", date_actual_settlement: null, listing: { id: 7 } },
    { id: 2, contract_status: "Accepted", date_expec_settlement: "2026-12-20", date_actual_settlement: null },
    { id: 3, contract_status: "offer", date_expec_settlement: "2026-11-10", date_actual_settlement: null },
    { id: 4, contract_status: "unconditional", date_expec_settlement: "2026-11-05", date_actual_settlement: "2026-11-05" },
    { id: 5, contract_status: "unconditional", date_expec_settlement: null, date_actual_settlement: null },
  ];
  page = (o) => ({ result: { rows: o === 0 ? rows : [], total: rows.length }, error: null });
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    const u = new URL(String(url)); let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    hits.push({ method: init?.method ?? "GET", path: u.pathname, body });
    if (u.hostname === "api.rexsoftware.com" && u.pathname === "/v1/rex/contracts/search") return new Response(JSON.stringify(page(body?.offset ?? 0)), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not faked: " + u.hostname + u.pathname, { status: 404 });
  }) as any });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { REX_ACCESS_TOKEN: "rex-token" }); delete process.env.KIT_ALLOW_WRITES;
});
const ctxFor = (store: MemoryStore, settings: any = S, now = NOW) => context(WF, settings, store, now, () => {});

test("the Rex settlement op is a mapped read and no Rex live op exists", () => {
  for (const op of WF.draft_ops.rex) assert.equal(REXOPS.find((o) => o.id === op)?.kind, "read");
  assert.equal(WF.live_ops.rex, undefined);
});

test("register: reads contracts, keeps only watched statuses, leaves out a settled one, writes nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await register(ctxFor(store)), { matters: 3 });
  assert.equal(((await store.get<any>("matters", "1")) as any).events[0].date, "2026-11-11");
  assert.equal(await store.get("matters", "3"), undefined, "offer is not watched");
  assert.equal(await store.get("matters", "4"), undefined, "settled is left out");
  assert.deepEqual(((await store.get<any>("matters", "5")) as any).events, [], "no expected date");
  assert.ok(hits.every((h) => h.method === "POST" && h.path === "/v1/rex/contracts/search"));
});

test("check: an agreed date that differs from Rex is flagged once, one that matches is not, nothing is written to Rex", async () => {
  const store = new MemoryStore(); await register(ctxFor(store));
  await store.put("agreed", "1", { matter_id: "1", date: "2026-11-12", source: "solicitor email", recorded: NOW.toISOString() });
  await store.put("agreed", "2", { matter_id: "2", date: "2026-12-20", source: "contract", recorded: NOW.toISOString() });
  await store.put("agreed", "9", { matter_id: "9", date: "2026-12-20", source: "contract", recorded: NOW.toISOString() });
  await store.put("agreed", "bad", { matter_id: "bad", date: "2026-12-20", source: "x", recorded: NOW.toISOString() });
  assert.deepEqual(await check(ctxFor(store)), { created: 0, queued: 0, flagged: 1, skipped: 2 });
  assert.deepEqual((await check(ctxFor(store)) as any).flagged, 0, "flagged once");
  assert.equal(hits.filter((h) => h.path !== "/v1/rex/contracts/search").length, 0);
});

test("reminders: lists the contracts settling in the window once, and writes nothing to Rex", async () => {
  const store = new MemoryStore(); await register(ctxFor(store));
  assert.deepEqual(await reminders(ctxFor(store)), { drafted: 0, off: false, due: 1 });
  assert.deepEqual(((await store.get<any>("settlement-due", "latest")) as any).due, ["1:2026-11-11"]);
  assert.equal((await reminders(ctxFor(store)) as any).due, 0, "once per date");
});

test("contract_statuses must be set, a bad platform is refused, and a short or malformed list is refused whole", async () => {
  await assert.rejects(register(ctxFor(new MemoryStore(), { platform: "rex" })), /contract_statuses/);
  await assert.rejects(register(ctxFor(new MemoryStore(), { platform: "x" })), /platform must be smokeball or rex/);
  page = (o) => ({ result: { rows: o === 0 ? rows.slice(0, 2) : [], total: 5 }, error: null });
  await assert.rejects(register(ctxFor(new MemoryStore())), /came back short \(2 of 5\)/);
  page = () => ({ result: {}, error: null }); await assert.rejects(register(ctxFor(new MemoryStore())), /did not come back as a list/);
  page = () => ({ result: { rows: [] }, error: { m: 1 } }); await assert.rejects(register(ctxFor(new MemoryStore())), /returned an error/);
  page = (o) => ({ result: { rows: o === 0 ? [{ id: "../x" }] : [] }, error: null }); await assert.rejects(register(ctxFor(new MemoryStore())), /no usable id/);
});

test("Rex current snapshot excludes contracts that settle, leave watched status, or disappear after a prior register", async () => {
  const store = new MemoryStore();
  rows = [
    { id: 11, contract_status: "unconditional", date_expec_settlement: "2026-11-11", date_actual_settlement: null },
    { id: 12, contract_status: "accepted", date_expec_settlement: "2026-11-12", date_actual_settlement: null },
    { id: 13, contract_status: "unconditional", date_expec_settlement: "2026-11-13", date_actual_settlement: null },
  ];
  page = (o) => ({ result: { rows: o === 0 ? rows : [], total: rows.length }, error: null });
  await register(ctxFor(store));
  for (const id of ["11", "12", "13"]) await store.put("agreed", id, { matter_id: id, date: "2026-11-15", source: "solicitor confirmation", recorded: NOW.toISOString() });

  rows = [
    { id: 11, contract_status: "unconditional", date_expec_settlement: "2026-11-11", date_actual_settlement: "2026-11-10" },
    { id: 12, contract_status: "offer", date_expec_settlement: "2026-11-12", date_actual_settlement: null },
  ];
  assert.deepEqual(await check(ctxFor(store)), { created: 0, queued: 0, flagged: 0, skipped: 3 });
  assert.deepEqual(await reminders(ctxFor(store)), { drafted: 0, off: false, due: 0 });
  assert.deepEqual((await store.get<any>("rex-register", "current")), {});
  assert.deepEqual((await store.get<any>("settlement-due", "latest")).due, []);
});

test("Rex contract pagination refuses duplicate ids and malformed totals", async () => {
  const store = new MemoryStore();
  page = (o) => ({ result: { rows: o === 0
    ? Array.from({ length: 50 }, (_, i) => ({ id: i + 1, contract_status: "unconditional", date_expec_settlement: null, date_actual_settlement: null }))
    : [{ id: 1, contract_status: "unconditional", date_expec_settlement: null, date_actual_settlement: null }], total: 51 }, error: null });
  await assert.rejects(register(ctxFor(store)), /repeated contract in paginated results/);

  page = () => ({ result: { rows: [], total: "not-a-total" }, error: null });
  await assert.rejects(register(ctxFor(store)), /invalid contract total/);
});
