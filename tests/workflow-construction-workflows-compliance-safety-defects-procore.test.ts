// Defects workflow, Procore adapter. Every request goes to a fake network: no test reaches a real Procore account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { logDefects, chase, closeOut } from "../industries/construction/workflows/compliance-safety/defects/index.ts";

const DIR = "industries/construction/workflows/compliance-safety/defects";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { family: "defects-on-jobs", first_reminder_after_days: 1, reminder_every_days: 3, procore: { projects: [{ id: "4242", name: "12 Smith St" }] } };
const NOW = new Date("2026-11-09T00:00:00Z"), DAY = 864e5, LATER = new Date(NOW.getTime() + 2 * DAY);

type Hit = { method: string; path: string; query: URLSearchParams; body: any; headers: Headers };
let hits: Hit[] = [];
let punch: any[] = [];

function fake() {
  hits = [];
  punch = [
    { id: 501, name: "Cracked tile in bathroom", status: "Open", closed_at: null, deleted_at: null, updated_at: "2026-11-08T01:00:00Z" },
    { id: 502, name: "Plumbing leak under sink", status: "Overdue", closed_at: null, deleted_at: null, updated_at: "2026-11-08T01:00:00Z" },
  ];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body, headers: new Headers(init?.headers) });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname !== "api.procore.com") return new Response("wrong host", { status: 404 });
      if (p === "/rest/v1.1/punch_items" && m === "GET") return json(Number(u.searchParams.get("page") ?? 1) === 1 ? punch : []);
      if (/^\/rest\/v1\.0\/punch_items\/\d+\/comments$/.test(p) && m === "POST") return json({ id: 9, body: body?.comment?.body }, 201);
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PROCORE_ACCESS_TOKEN: "pc-token", PROCORE_COMPANY_ID: "777", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a comment and cannot queue a read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "procore", op: "punch-items.create-punch-item-comment", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "procore", op: "punch-items.list-punch-items", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("setting both defect_section and procore is refused before any call", async () => {
  const ctx = context(WF, { ...SETTINGS, defect_section: "Defects" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(logDefects(ctx), /either defect_section .* or procore/);
  assert.equal(hits.length, 0);
});

test("log-defects records each punch item once, with the company header, creating no task and writing nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await logDefects(ctx), { logged: 2, tasks: 2 }, "the task counter counts the no-op task reference");
  const d = (await store.get<any>("defects", "501")) as any;
  assert.equal(d.name, "Cracked tile in bathroom"); assert.equal(d.status, "open"); assert.equal(d.job_uuid, "4242"); assert.equal(d.address, "12 Smith St");
  assert.equal(writes().length, 0, "reads only");
  const first = hits[0];
  assert.equal(first.query.get("project_id"), "4242"); assert.equal(first.query.get("page"), "1");
  assert.equal(first.headers.get("procore-company-id"), "777"); assert.equal(first.headers.get("authorization"), "Bearer pc-token");
  assert.deepEqual(await logDefects(ctx), { logged: 0, tasks: 0 }, "a rerun logs nothing new");
});

test("a closed punch item is recorded as fixed, a deleted one is never logged", async () => {
  punch.push({ id: 503, name: "Door sticks", status: "Closed", closed_at: "2026-11-08T05:00:00Z", deleted_at: null }, { id: 504, name: "Removed", status: "Open", deleted_at: "2026-11-07T00:00:00Z" });
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await logDefects(ctx);
  const d = (await store.get<any>("defects", "503")) as any;
  assert.equal(d.status, "fixed"); assert.equal(d.fixed_at, "2026-11-08T05:00:00Z");
  assert.equal(await store.get("defects", "504"), undefined, "a deleted item is not logged");
});

test("paging runs to an empty page and a project with too many pages is refused whole", async () => {
  const store = new MemoryStore();
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any) => {
    const u = new URL(String(url)); hits.push({ method: "GET", path: u.pathname, query: u.searchParams, body: undefined, headers: new Headers() });
    const page = Number(u.searchParams.get("page") ?? 1);
    return new Response(JSON.stringify([{ id: 1000 + page, name: `Item ${page}`, status: "Open" }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as any });
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await assert.rejects(logDefects(ctx), /longer than 20 pages; refused whole/);
  assert.equal(hits.length, 20);
  assert.deepEqual(Object.keys(await store.list("defects")), [], "a refused list records nothing");
});

test("a 200 that is not a list fails the read", async () => {
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async () => new Response(JSON.stringify({ errors: "rate limited" }), { status: 200, headers: { "content-type": "application/json" } })) as any });
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(logDefects(ctx), /did not come back as a list/);
});

test("chase queues one comment per due open item for approval, re-runs queue nothing new, the approved comment goes once", async () => {
  const store = new MemoryStore();
  await logDefects(context(WF, SETTINGS, store, NOW, () => {}));
  const ctx = context(WF, SETTINGS, store, LATER, () => {});
  assert.deepEqual(await chase(ctx), { queued: 2, no_trade_contact: 0 });
  assert.equal(writes().length, 0, "nothing is sent until approved");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.match(pending[0].summary, /Procore comment on punch item .* at 12 Smith St/);
  assert.deepEqual(await chase(ctx), { queued: 0, no_trade_contact: 0 }, "not due again yet");
  await approve(WF, store, pending[0].id, "owner", LATER);
  const posts = writes();
  assert.equal(posts.length, 1);
  assert.match(posts[0].path, /^\/rest\/v1\.0\/punch_items\/50[12]\/comments$/);
  assert.equal(posts[0].query.get("project_id"), "4242");
  assert.deepEqual(posts[0].body, { comment: { body: "Reminder: this punch item is still open. Please fix it and mark it ready to close in Procore." } });
  assert.equal(posts[0].headers.get("procore-company-id"), "777");
});

test("a punch item closed in Procore stops being chased", async () => {
  const store = new MemoryStore();
  await logDefects(context(WF, SETTINGS, store, NOW, () => {}));
  punch[0].status = "Closed"; punch[0].closed_at = "2026-11-10T00:00:00Z";
  const ctx = context(WF, SETTINGS, store, LATER, () => {});
  assert.deepEqual(await chase(ctx), { queued: 1, no_trade_contact: 0 }, "only the still-open item is chased");
  assert.equal(((await store.get<any>("defects", "501")) as any).status, "fixed");
});

test("close-out records the project once when every item is closed, and sends nothing", async () => {
  const store = new MemoryStore();
  await logDefects(context(WF, SETTINGS, store, NOW, () => {}));
  for (const x of punch) { x.status = "Closed"; x.closed_at = "2026-11-10T00:00:00Z"; }
  const ctx = context(WF, SETTINGS, store, LATER, () => {});
  assert.deepEqual(await closeOut(ctx), { tasks: 1, sign_off_queued: 0 });
  assert.equal(((await store.get<any>("jobs", "4242")) as any).task_ref, "closed-in-procore");
  assert.deepEqual(await closeOut(ctx), { tasks: 0, sign_off_queued: 0 }, "recorded once");
  assert.equal(Object.values(await store.list("approvals")).length, 0, "no email and no approval");
  assert.equal(writes().length, 0);
});

test("a project id that is not a number is refused before any call", async () => {
  const ctx = context(WF, { ...SETTINGS, procore: { projects: [{ id: "4242/../9", name: "x" }] } }, new MemoryStore(), NOW, () => {});
  await assert.rejects(logDefects(ctx), /bad id/);
  assert.equal(hits.length, 0);
});
