// Proof-of-delivery workflow tests. Every request goes to a fake Onfleet: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { pods, needsProof, reattempt } from "../industries/transport/workflows/fulfilment/x-pod/index.ts";
import { onfleetId, toPod, listCompleted, reattemptAct } from "../industries/transport/workflows/fulfilment/x-pod/adapters/onfleet.ts";
import type { Pod, Settings } from "../industries/transport/workflows/fulfilment/x-pod/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/transport/workflows/fulfilment/x-pod/workflow.json", "utf8")) as WorkflowRecord;
const S: Settings = { business_name: "Test Transport", lookback_days: 30, max_pages: 10, proof_grace_hours: 2, reattempt: true };
const NOW = new Date("2026-11-08T12:00:00Z");
const HOUR = 36e5;
const at = (h: number) => NOW.getTime() - h * HOUR;

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let tasks: Record<string, any> = {};
let pageSize = 64;
let created = 0;

const task = (id: string, o: { hoursAgo?: number; reason?: string; photo?: string | null; sig?: string | null; noTime?: boolean } = {}) => ({
  id, shortId: id.slice(-4).toLowerCase(), worker: "W1", state: 3, notes: "",
  destination: { id: `D-${id}`, address: { number: "888", street: "Brannan Street", apartment: "", city: "San Francisco", state: "California", postalCode: "94103", country: "United States" } },
  recipients: [{ id: `R-${id}`, name: "Mikel", phone: "+61400000000" }],
  completionDetails: o.noTime ? {} : { time: at(o.hoursAgo ?? 1), successNotes: "left at the gate", failureNotes: "", failureReason: o.reason ?? "NONE",
    photoUploadId: o.photo === undefined ? "photo-1" : o.photo, photoUploadIds: [], signatureUploadId: o.sig === undefined ? null : o.sig },
});

function fake() {
  hits = []; created = 0;
  tasks = {
    A1: task("A1", { hoursAgo: 3, photo: null, sig: null }),                    // bare, past grace: should be flagged
    B1: task("B1", { hoursAgo: 0.5, photo: null, sig: null }),                  // bare, inside grace: not read yet
    C1: task("C1", { hoursAgo: 4, photo: null, sig: null }),                    // bare now, photo added later
    F1: task("F1", { hoursAgo: 2, reason: "UNABLE_TO_LOCATE", photo: null }),   // failed stop
    OK1: task("OK1", { hoursAgo: 5 }),                                          // complete with a photo
  };
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/api/v2/tasks/all" && m === "GET") {
        const from = Number(u.searchParams.get("from")), state = u.searchParams.get("state");
        const all = Object.values(tasks).filter((t) => t.state === 3 && state === "3" && t.completionDetails?.time >= from)
          .sort((a, b) => a.id.localeCompare(b.id));
        const start = u.searchParams.get("lastId") ? all.findIndex((t) => t.id === u.searchParams.get("lastId")) + 1 : 0;
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return json({ ...(more ? { lastId: page[page.length - 1].id } : {}), tasks: page });
      }
      const one = /^\/api\/v2\/tasks\/([^/]+)$/.exec(p);
      if (one && m === "GET") { const t = tasks[decodeURIComponent(one[1])]; return t ? json(t) : new Response("{}", { status: 404 }); }
      if (p === "/api/v2/tasks" && m === "POST") { created++; return new Response(JSON.stringify({ id: `NEW${created}`, shortId: "n" }), { status: 200, headers: { "content-type": "application/json" } }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");
const reads = (re: RegExp) => hits.filter((h) => h.method === "GET" && re.test(h.path));

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { ONFLEET_API_KEY: "test-key", KIT_ALLOW_WRITES: "1" });
});

test("pods reads completed stops into the register and writes nothing to Onfleet", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  const r = await pods(ctx);
  assert.equal(r.added, 5, "five completed stops with a completion time");
  assert.equal(r.skipped, 0);
  assert.equal(toPod({ ...task("G1", { noTime: true }) }, NOW), undefined, "a task with no completion time is not registered");
  assert.equal(writes().length, 0, "no write reached Onfleet");
  const listed = reads(/^\/api\/v2\/tasks\/all$/);
  assert.equal(listed.length >= 1, true, "the walk read the completed-task list");
  assert.equal(listed[0].query.get("from"), String(NOW.getTime() - 30 * 864e5), "from is the lookback floor (30 days) on a first run");
  const list = await store.list<Pod>("pods");
  assert.equal(Object.values(list).find((p) => p.task_id === "A1")?.status, "needs-proof");
  assert.equal(Object.values(list).find((p) => p.task_id === "OK1")?.status, "complete");
  assert.equal(Object.values(list).find((p) => p.task_id === "F1")?.failed, true);
  assert.equal(Object.values(list).find((p) => p.task_id === "A1")?.address, "888 Brannan Street San Francisco California 94103");
  assert.deepEqual(Object.values(list).find((p) => p.task_id === "A1")?.recipient_ids, ["R-A1"], "no name or phone is kept");
  assert.equal(JSON.stringify(list).includes("+61400000000"), false);
});

test("pods re-runs add nothing new and carry the cursor forward", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  const again = await pods(ctx);
  assert.equal(again.added, 0);
  assert.equal(Object.keys(await store.list<Pod>("pods")).length, 5);
});

test("pods pages through lastId and keeps its place when a run is cut short", async () => {
  pageSize = 2;
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  const first = await pods({ ...ctx, settings: { ...S, max_pages: 1 } });
  assert.equal(first.more, true);
  const cursor = await store.get<{ from: number; lastId?: string }>("cursor", "onfleet");
  assert.ok(cursor?.lastId, "the cut-short run saves its lastId");
  await pods(ctx);
  assert.equal(Object.keys(await store.list<Pod>("pods")).length, 5, "the second run finishes the walk without losing a stop");
});

test("needs-proof flags a bare stop past the grace period, leaves a fresh one alone, and clears one that got a photo", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  // C1 gets its photo in Onfleet after the register first saw it bare.
  tasks.C1 = task("C1", { hoursAgo: 4, photo: "late-photo" });
  const r = await needsProof(ctx);
  assert.equal(r.checked, 2, "A1 and C1 are past grace; B1 is not");
  assert.equal(reads(/^\/api\/v2\/tasks\/B1$/).length, 0, "the fresh stop is not read yet");
  const list = Object.values(await store.list<Pod>("pods"));
  assert.equal(list.find((p) => p.task_id === "A1")?.status, "needs-proof");
  assert.equal(list.find((p) => p.task_id === "C1")?.status, "complete");
  assert.equal(list.find((p) => p.task_id === "B1")?.status, "needs-proof");
  assert.equal(writes().length, 0);
});

test("a failed stop queues a re-attempt for approval; nothing is created until a person approves, and re-runs never double-queue", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  const first = await reattempt(ctx);
  assert.equal(first.queued, 1, "only F1 failed");
  assert.equal(writes().length, 0, "no task created by a cron");
  const pod = Object.values(await store.list<Pod>("pods")).find((p) => p.task_id === "F1")!;
  assert.equal(pod.status, "reattempt-queued");
  const pending = await store.list<Approval>("approvals");
  assert.equal(Object.keys(pending).length, 1);
  const ap = Object.values(pending)[0];
  assert.equal(ap.status, "pending");
  assert.equal(ap.acts[0].op, "core.docs.post_tasks");
  assert.equal((ap.acts[0].input as any).body.destination, "D-F1", "the queued create names the stop's destination");
  assert.match(ap.summary, /UNABLE_TO_LOCATE/);
  await reattempt(ctx);
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "a re-run never queues the same re-attempt twice");
});

test("approval creates the re-attempt with the same destination and recipient, and the next run records its id", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  await reattempt(ctx);
  const pod = Object.values(await store.list<Pod>("pods")).find((p) => p.task_id === "F1")!;
  const done = await approve(WF, store, pod.approval!, "owner", NOW);
  assert.equal(done.status, "done");
  const post = writes().find((h) => h.method === "POST" && h.path === "/api/v2/tasks")!;
  assert.equal(post.body.destination, "D-F1");
  assert.deepEqual(post.body.recipients, ["R-F1"]);
  assert.match(post.body.notes, /Re-attempt of .*UNABLE_TO_LOCATE/);
  await reattempt(ctx);
  const after = (await store.get<Pod>("pods", pod.key))!;
  assert.equal(after.status, "reattempt-created");
  assert.equal(after.reattempt_task, "NEW1");
  await reattempt(ctx);
  assert.equal(writes().length, 1, "the create ran once");
});

test("a rejected re-attempt is recorded and never queued again", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  await reattempt(ctx);
  const pod = Object.values(await store.list<Pod>("pods")).find((p) => p.task_id === "F1")!;
  await store.put("approvals", pod.approval!, { ...(await store.get<Approval>("approvals", pod.approval!))!, status: "rejected" });
  await reattempt(ctx);
  assert.equal((await store.get<Pod>("pods", pod.key))!.status, "reattempt-rejected");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("with writes closed on the deploy, an approved re-attempt fails and sends nothing", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  await reattempt(ctx);
  const pod = Object.values(await store.list<Pod>("pods")).find((p) => p.task_id === "F1")!;
  const ap = await approve(WF, store, pod.approval!, "owner", NOW);
  assert.equal(ap.status, "failed");
  assert.equal(writes().length, 0, "no POST left the process");
});

test("runtime: a cron cannot draft the create, and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "onfleet", op: "core.docs.post_tasks", summary: "x", input: { body: {} } }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "onfleet", op: "core.docs.get_tasks_all", summary: "x" }), /not a live operation/);
  assert.equal(writes().length, 0);
});

test("ids from outside are checked before they reach a path or a query", () => {
  assert.equal(onfleetId("qNMz6CKwQ*26FOslywsiQxhY"), "qNMz6CKwQ*26FOslywsiQxhY");
  assert.throws(() => onfleetId("../tasks/all"), /bad id/);
  assert.throws(() => onfleetId("A1?state=1"), /bad id/);
});

test("get_tasks_all always carries a past millisecond from; a bad window is refused before any request", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(listCompleted(ctx, NaN), /past millisecond timestamp/);
  await assert.rejects(listCompleted(ctx, NOW.getTime() + 1e6), /past millisecond timestamp/);
  await assert.rejects(listCompleted(ctx, 1.5), /past millisecond timestamp/);
  assert.equal(hits.length, 0, "nothing reached the network");
});

test("a re-attempt always names a destination, and a stop without one is refused", () => {
  const p = { key: "pod:X", task_id: "X", recipient_ids: [], failed: true, photo_count: 0, photo_ids: [], signature: false, completed: NOW.toISOString(), status: "failed" } as Pod;
  assert.throws(() => reattemptAct(p), /destination id/);
  const act = reattemptAct({ ...p, destination_id: "D-X" });
  assert.equal((act.input as any).body.destination, "D-X");
});

test("a re-attempt summary keeps the street address out (it is logged) and shows the failure date", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  await reattempt(ctx);
  const ap = Object.values(await store.list<Approval>("approvals"))[0];
  assert.doesNotMatch(ap.summary, /Brannan|888|94103/, "no street address in the summary or the log line");
  assert.match(ap.summary, /2026-11-08/, "the failure date is in the summary");
  assert.match(ap.summary, /UNABLE_TO_LOCATE/);
});

test("a stop that failed more than a week ago is not queued for a re-attempt", async () => {
  tasks.OLD1 = task("OLD1", { hoursAgo: 24 * 10, reason: "UNABLE_TO_LOCATE", photo: null });
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  const r = await reattempt(ctx);
  assert.equal(r.queued, 1, "only the recent failure F1 is queued");
  assert.equal((await store.get<Pod>("pods", "pod:OLD1"))?.status, "failed");
  assert.equal(writes().length, 0);
});

test("re-attempts queued per run are capped, newest failure first", async () => {
  pageSize = 64; // an earlier test leaves the page size at 2
  for (let i = 0; i < 25; i++) tasks[`X${String(i).padStart(2, "0")}`] = task(`X${String(i).padStart(2, "0")}`, { hoursAgo: 1 + i, reason: "UNABLE_TO_LOCATE", photo: null });
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await pods(ctx);
  const r = await reattempt(ctx);
  assert.equal(r.queued, 20, "no more than 20 approvals in one run");
  const queuedIds = Object.values(await store.list<Pod>("pods")).filter((p) => p.status === "reattempt-queued").map((p) => p.task_id).sort();
  assert.equal(queuedIds.length, 20);
  assert.ok(queuedIds.includes("X00"), "the newest failure is queued");
  assert.ok(!queuedIds.includes("X24"), "the oldest failure waits");
});
