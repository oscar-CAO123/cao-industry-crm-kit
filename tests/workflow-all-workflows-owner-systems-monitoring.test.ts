// Systems monitoring workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { check, alert } from "../industries/all/workflows/owner/systems-monitoring/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/owner/systems-monitoring";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com.au", OWNER = "owner@example.com.au";
const DAYMS = 864e5;
const NOW = new Date("2026-11-08T21:00:00Z");
const SET: any = { family: "all", business_name: "Test Trades", checks: ["make", "microsoft-365"], alert_to: OWNER,
  microsoft_365: { mailbox: MAILBOX }, make: { team_id: "77", expiry_warn_days: 14 } };

type Hit = { method: string; host: string; path: string; body: any; team?: string | null };
let hits: Hit[] = [];
let failMake = false;
let world: any;

const freshWorld = () => ({
  connections: [
    { id: 501, accountLabel: "Xero (Example)", expire: "2027-06-01T00:00:00Z" },
    { id: 502, accountLabel: "Gmail (ops)", expire: "2026-11-12T00:00:00Z" },
  ],
  scenarios: [
    { id: 901, name: "Quote intake", dlqCount: 0, isinvalid: false },
    { id: 902, name: "Invoice <img src=x onerror=alert(1)> sync", dlqCount: 2, isinvalid: false },
    { id: 903, name: "Retired", deleted: true, dlqCount: 0 },
  ],
  logs: {
    901: [{ status: 1, timestamp: NOW.getTime() - 3600e3 }],
    902: [{ status: 3, timestamp: NOW.getTime() - 3600e3 }, { status: 3, timestamp: NOW.getTime() - 5 * DAYMS }],
  } as Record<string, any[]>,
  health: [
    { id: "Exchange", service: "Exchange Online", status: "serviceOperational" },
    { id: "Teams", service: "Microsoft Teams", status: "serviceDegradation" },
  ],
  issues: { Teams: [{ title: "Users cannot join meetings", isResolved: false }] } as Record<string, any[]>,
});

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.host, path: p, body, team: u.searchParams.get("teamId") });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.host === "eu1.make.com") {
        if (failMake) return json({ message: "down" }, 500);
        if (p === "/api/v2/connections") return json({ connections: world.connections });
        if (p === "/api/v2/scenarios") return json({ scenarios: world.scenarios });
        const lg = p.match(/^\/api\/v2\/scenarios\/(\d+)\/logs$/);
        if (lg) return json({ scenarioLogs: world.logs[lg[1]] ?? [] });
      }
      if (u.host === "graph.microsoft.com") {
        if (p === "/v1.0/admin/serviceAnnouncement/healthOverviews") return json({ value: world.health });
        const iss = p.match(/^\/v1\.0\/admin\/serviceAnnouncement\/healthOverviews\/([^/]+)\/issues$/);
        if (iss) return json({ value: world.issues[decodeURIComponent(iss[1])] ?? [] });
        if (/^\/v1\.0\/users\/[^/]+\/messages$/.test(p) && m === "POST") return json({ id: "AAMkDraft1" }, 201);
        if (/^\/v1\.0\/users\/[^/]+\/messages\/[^/]+\/send$/.test(p) && m === "POST") return json({}, 202);
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const drafts = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const sends = () => hits.filter((h) => /\/send$/.test(h.path));

beforeEach(() => {
  world = freshWorld();
  failMake = false;
  fake();
  Object.assign(process.env, { MAKE_API_TOKEN: "mk", M365_ACCESS_TOKEN: "ms", KIT_ALLOW_WRITES: "1" });
  delete process.env.MAKE_ZONE;
});

test("runtime: Make and service health are draft reads only; the only queueable operation is the owner's alert send", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "make", op: "core.docs.get_hooks", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "make", op: "core.docs.get_connections", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
});

test("check: flags the expiring key, the dead-letter scenario and the degraded service; sends nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await check(context(WF, SET, store, NOW, () => {})), { checked: 6, failing: 3, unreadable: [] });
  assert.equal((await store.get<any>("checks", "make:connection:501"))?.ok, true);
  assert.match((await store.get<any>("checks", "make:connection:502"))?.reason ?? "", /expires in 3 days/);
  const s902 = await store.get<any>("checks", "make:scenario:902");
  assert.match(s902?.reason ?? "", /dead-letter/);
  assert.match(s902?.reason ?? "", /1 error in the last 24 hours/);
  assert.match((await store.get<any>("checks", "microsoft-365:service:Teams"))?.reason ?? "", /Users cannot join meetings/);
  assert.equal((await store.get<any>("checks", "make:scenario:903")), undefined, "a deleted scenario is not checked");
  assert.equal(hits.filter((h) => h.method !== "GET").length, 0, "the check cron makes no write at all");
  for (const h of hits.filter((h) => h.host === "eu1.make.com" && /\/(connections|scenarios)$/.test(h.path))) assert.equal(h.team, "77", "Make lists are read for the configured team");
});

test("alert: one draft and one queued send for the new failures; a re-run drafts and queues nothing more", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, SET, store, NOW, () => {});
  await check(ctx());
  assert.deepEqual(await alert(ctx()), { alerted: 3 });
  assert.equal(drafts().length, 1);
  assert.equal(sends().length, 0, "nothing is sent before approval");
  const body = drafts()[0].body.body.content as string;
  assert.ok(!body.includes("<img"), "the scenario name is escaped in the email");
  assert.ok(body.includes("&lt;img"));
  const apps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "pending");
  assert.equal(apps[0].acts[0].op, "users.user.messages.message.send");
  await check(ctx());
  assert.deepEqual(await alert(ctx()), { alerted: 0 });
  assert.equal(drafts().length, 1);
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
});

test("approval: the owner's approval sends the alert once", async () => {
  const store = new MemoryStore();
  await check(context(WF, SET, store, NOW, () => {}));
  await alert(context(WF, SET, store, NOW, () => {}));
  const id = Object.keys(await store.list("approvals"))[0];
  const ap = await approve(WF, store, id, "oscar", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  await assert.rejects(approve(WF, store, id, "oscar", NOW), /already done/);
});

test("check: a platform that cannot be read is a failing check, and the other platform still runs", async () => {
  failMake = true;
  const store = new MemoryStore();
  const r = await check(context(WF, SET, store, NOW, () => {}));
  assert.deepEqual(r.unreadable, ["make"]);
  assert.equal((await store.get<any>("checks", "make:platform"))?.ok, false);
  assert.equal((await store.get<any>("checks", "microsoft-365:service:Teams"))?.ok, false);
  assert.equal((await store.get<any>("checks", "microsoft-365:service:Exchange"))?.ok, true);
});
