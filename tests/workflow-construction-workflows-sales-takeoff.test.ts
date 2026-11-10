// Tender reader (construction takeoff) workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, takeoff, digest } from "../industries/construction/workflows/sales/takeoff/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/sales/takeoff/workflow.json", "utf8")) as WorkflowRecord;
const MAILBOX = "tenders@example.com.au", DIGEST_TO = "estimator@example.com.au";
const PROJECT = "4f1c2b7e-9a3d-4e5f-8a6b-1c2d3e4f5a6b", FILE = 555, JOB = 77;
const WB = { drive: "DRIVE1", item: "ITEM1", table: "BidRegister" };
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let markupReads = 0;

function fake() {
  hits = []; markupReads = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // Microsoft Graph
      if (/\/messages\/[^/]+\/send$/.test(p)) return new Response(null, { status: 202 });
      if (p.endsWith("/messages") && m === "POST") return json({ id: "AAMkDigest1" });
      if (p.endsWith("/messages")) return json({ value: [{ id: "AAMkNotice1", subject: "Tender 4471: fencing package", from: { emailAddress: { name: "Ari", address: "ari@council.example" } }, receivedDateTime: "2026-11-08T01:00:00Z", bodyPreview: "Plans attached" }] });
      if (p.endsWith("/rows") && m === "POST") return json({ index: 0 });
      // Bluebeam
      if (p.endsWith(`/projects/${PROJECT}/files`)) return json({ ProjectFiles: [{ Id: FILE, Name: "Tender 4471 plans.pdf", Path: "/Tender 4471 plans.pdf" }, { Id: 9, Name: "notes.docx" }], TotalCount: 2 });
      if (p.endsWith(`/files/${FILE}/jobs/markuplist`) && m === "POST") return json({ Id: JOB });
      if (p.endsWith(`/files/${FILE}/jobs/markuplist/${JOB}`)) {
        markupReads++;
        return json(markupReads < 2 ? { JobStatus: 1, JobStatusMessage: "running" }
          : { JobStatus: 2, JobStatusMessage: "done", Markups: [{ Id: "a1", Page: 3, Type: "Area", Subject: "Demolition", Comment: "slab", Author: "Owner", DateCreated: "2026-11-08T02:00:00Z" }, { Id: "a2", Page: 4, Type: "Length", Subject: "Fence line", Comment: "" }] });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$/.test(h.path));
const SETTINGS: any = {
  family: "tender-takeoff", business_name: "Example Civil",
  microsoft_365: { mailbox: MAILBOX, folder: "inbox", search: "tender", digest_to: DIGEST_TO, register: WB, takeoff: { ...WB, table: "Takeoff" } },
  bluebeam: { project_id: PROJECT, max_polls: 8 },
};
const NOW = new Date("2026-11-08T03:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", BLUEBEAM_ACCESS_TOKEN: "bb", BLUEBEAM_CLIENT_ID: "cid", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "bluebeam", op: "ProjectFiles_GetAll", summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("crons log, measure and draft; nothing is sent by a cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 1 });
  const row = hits.find((h) => h.path.endsWith("/rows") && h.method === "POST")!.body.values[0];
  assert.deepEqual(row.slice(1), ["m365:AAMkNotice1", "Tender 4471: fencing package", "ari@council.example", "Logged"]);
  assert.deepEqual(await intake(ctx), { added: 0 }, "a notice is logged once");

  assert.deepEqual(await takeoff(ctx), { drafted: 0, waiting: 1 }, "first run starts the markup list");
  assert.ok(hits.some((h) => h.path.endsWith(`/files/${FILE}/jobs/markuplist`) && h.method === "POST"));
  assert.deepEqual(await takeoff(ctx), { drafted: 0, waiting: 1 }, "second run: Bluebeam has no markups yet");
  assert.deepEqual(await takeoff(ctx), { drafted: 1, waiting: 0 }, "third run writes the rows");
  const takeoffWrite = hits.filter((h) => h.path.endsWith("/rows") && h.method === "POST").at(-1)!.body.values;
  assert.deepEqual(takeoffWrite.map((r: any[]) => [r[1], r[2], r[3]]), [[3, "Area", "Demolition"], [4, "Length", "Fence line"]]);

  assert.equal((await digest(ctx)).queued, 1, "digest drafted and queued");
  assert.equal(sends().length, 0, "nothing sent by a cron");
});

test("the digest is queued once a day, and only the approved send mails it", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await digest(ctx).then((r) => r.queued), 1);
  assert.deepEqual(await digest(ctx), { queued: 0 }, "a re-run the same day never queues again");
  const drafts = hits.filter((h) => h.path.endsWith("/messages") && h.method === "POST");
  assert.equal(drafts.length, 1, "one draft only");
  assert.equal(drafts[0].body.toRecipients[0].emailAddress.address, DIGEST_TO);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.op), ["users.user.messages.message.send"]);
  assert.equal(sends().length, 0);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(sends().length, 1);
  assert.match(sends()[0].path, /\/messages\/AAMkDigest1\/send$/);
});

test("a bad Bluebeam project id is refused before any call is made", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  hits = [];
  const bad = { ...SETTINGS, bluebeam: { project_id: "../../etc" } };
  await assert.rejects(takeoff(context(WF, bad, store, NOW, () => {})), /not a project id/);
  assert.equal(hits.filter((h) => h.path.includes("/projects/")).length, 0);
});

test("an empty markup list is not a finished job: the cron keeps polling and never drafts empty rows", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  hits = [];
  // Bluebeam answers every poll with an empty Markups list while the job is still running.
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const p = new URL(String(url)).pathname, m = init?.method ?? "GET";
      hits.push({ method: m, path: p, body: undefined });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith(`/projects/${PROJECT}/files`)) return json({ ProjectFiles: [{ Id: FILE, Name: "Tender 4471 plans.pdf" }], TotalCount: 1 });
      if (p.endsWith(`/files/${FILE}/jobs/markuplist`) && m === "POST") return json({ Id: JOB });
      if (p.endsWith(`/files/${FILE}/jobs/markuplist/${JOB}`)) return json({ JobStatus: 1, JobStatusMessage: "running", Markups: [] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await takeoff(ctx), { drafted: 0, waiting: 1 }, "starts the markup list");
  for (let i = 0; i < 8; i++) assert.deepEqual(await takeoff(ctx), { drafted: 0, waiting: 1 }, "an empty list is still waiting");
  assert.equal(hits.filter((h) => h.path.endsWith("/rows") && h.method === "POST").length, 0, "no takeoff rows written");
  const t = Object.values(await store.list<any>("tenders"))[0];
  assert.equal(t.status, "needs-check", "after max_polls the tender is flagged for a person, not marked drafted");
  assert.deepEqual(await takeoff(ctx), { drafted: 0, waiting: 0 }, "a flagged tender is not polled again");
});
