// Shift note workflow tests. Every request goes to a fake network: no test reaches a real Deputy account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { describe } from "../core/sdk/call.ts";
import { collect, check, CRONS } from "../industries/health-care/workflows/compliance-safety/shiftnotes/index.ts";
import { checkNote, keyOf, type Settings } from "../industries/health-care/workflows/compliance-safety/shiftnotes/types.ts";
import fs from "node:fs";

const DIR = "industries/health-care/workflows/compliance-safety/shiftnotes";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const S = JSON.parse(fs.readFileSync(`${DIR}/settings.example.json`, "utf8")) as Settings;
const NOW = new Date("2026-11-09T06:00:00Z");
const GOOD = "Supported Sam with the morning routine and medication prompts. Client was calm and settled, no incidents to report.";
const SHORT = "Went fine.";
const MARK = "Shift note check (automatic";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let rows: any[] = [];
let comments: Record<string, { Comment: string }[]> = {};

function fake() {
  hits = []; comments = {};
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/QUERY")) return json(rows);
      const c = p.match(/\/Timesheet\/([^/]+)\/COMMENTS$/);
      if (c && m === "GET") return json(comments[c[1]] ?? []);
      if (c && m === "POST") { (comments[c[1]] ??= []).push({ Comment: body.Comment }); return json({ Id: 1 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const commentPosts = () => hits.filter((h) => h.method === "POST" && /\/Timesheet\/[^/]+\/COMMENTS$/.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { DEPUTY_ACCESS_TOKEN: "tok", DEPUTY_SUBDOMAIN: "exampleco", DEPUTY_REGION: "au", KIT_ALLOW_WRITES: "1" });
  rows = [
    { Id: 101, Date: "2026-11-09", EmployeeComment: GOOD },
    { Id: 102, Date: "2026-11-09", EmployeeComment: "   " },          // empty note: skipped
    { Id: "7/../x", Date: "2026-11-09", EmployeeComment: GOOD },       // bad id: never reaches a path
    { Id: "103", Date: "2026-11-09", EmployeeComment: SHORT },         // numeric string id: accepted
  ];
});

test("the checks: a full note passes and a short one misses every point", () => {
  assert.deepEqual(checkNote(GOOD, S), []);
  assert.equal(checkNote(SHORT, S).length, 4, "too short plus the three points");
});

test("collect keeps notes that have text and skips empty notes and bad ids", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await collect(ctx), { added: 2, skipped: 2 });
  assert.ok(await store.get("shiftnotes", keyOf(101)));
  assert.ok(await store.get("shiftnotes", keyOf(103)));
  assert.ok(hits.every((h) => h.method === "GET" || h.path.endsWith("/QUERY")), "collect only reads");
});

test("check flags a note that misses a point, comments once on its timesheet, and never sends", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  assert.deepEqual(await check(ctx), { ok: 1, flagged: 1 });
  assert.equal(commentPosts().length, 1);
  assert.equal(commentPosts()[0].path.includes("/Timesheet/103/COMMENTS"), true);
  assert.ok(commentPosts()[0].body.Comment.startsWith(MARK));
  assert.equal(hits.filter((h) => h.method !== "GET" && !h.path.endsWith("/QUERY") && !/\/COMMENTS$/.test(h.path)).length, 0, "no other writes");
});

test("re-runs never add a second comment, even when the store lost its record", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx); await check(ctx);
  await collect(ctx); await check(ctx);
  assert.equal(commentPosts().length, 1, "store record stops the repeat");
  const fresh = context(WF, S, new MemoryStore(), NOW, () => {});
  await collect(fresh); await check(fresh);
  assert.equal(commentPosts().length, 1, "an existing marker comment stops it even with an empty store");
});

test("the write gate blocks the review comment when writes are not allowed", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await collect(ctx);
  await assert.rejects(check(ctx), WriteBlocked);
  assert.equal(commentPosts().length, 0);
  assert.equal((await store.get<any>("shiftnotes", keyOf(103))).status, "new", "the note stays new so a later run can flag it");
});

test("no live operation is reachable: a delete or a message is refused for this workflow", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "deputy", op: "deputy-v1-resource-api.deleteCommentTimesheet", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "deputy", op: "deputy-v1-supervise-api.supervise_memo__put", summary: "x" }), /not a live operation/);
});

test("the workflow record matches its crons and every draft op is mapped in the kit", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
  for (const [platform, ops] of Object.entries(WF.draft_ops)) for (const op of ops) assert.doesNotThrow(() => describe(platform, op), op);
});
