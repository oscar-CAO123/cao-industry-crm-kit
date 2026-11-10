// Document-intake workflow tests. Every request goes to a fake network: no test reaches a real Dropbox account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/all/workflows/finance-admin/document-intake/index.ts";
import type { Settings } from "../industries/all/workflows/finance-admin/document-intake/types.ts";
import fs from "node:fs";
import path from "node:path";

const WF = JSON.parse(fs.readFileSync(path.join(process.cwd(), "industries/all/workflows/finance-admin/document-intake/workflow.json"), "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const noop = () => {};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let folders: Set<string>;

const ENTRIES = [
  { ".tag": "file", id: "id:AAA111", name: "Supplier invoice May.pdf", path_display: "/Intake/Supplier invoice May.pdf", server_modified: "2026-11-06T09:00:00Z" },
  { ".tag": "file", id: "id:BBB222", name: "Mystery scan.pdf", path_display: "/Intake/Mystery scan.pdf", server_modified: "2026-11-06T10:00:00Z" },
  { ".tag": "folder", id: "id:FFF333", name: "Old", path_display: "/Intake/Old" },
  { ".tag": "file", id: "id:CCC333", name: "liability note.pdf", path_display: "/Intake/liability note.pdf", server_modified: "2026-11-06T11:00:00Z" },
];

function fake() {
  hits = []; folders = new Set(["/Intake", "/Intake/To review"]);
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith("/files/list_folder")) return json({ entries: body?.path === "/Intake" ? ENTRIES : [], has_more: false, cursor: "c" });
      if (p.endsWith("/files/get_metadata")) return folders.has(body?.path) ? json({ ".tag": "folder", path_display: body.path })
        : json({ error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } }, 409);
      if (p.endsWith("/files/create_folder_v2")) { folders.add(body.path); return json({ metadata: { path_display: body.path } }); }
      if (p.endsWith("/files/move_v2")) return json({ metadata: { ".tag": "file", path_display: body.to_path } });
      if (p.endsWith("/file_requests/create")) return json({ id: "rq1", url: "https://www.dropbox.com/request/rq1", title: body.title });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const S: Settings = {
  intake_folder: "/Intake", review_folder: "/Intake/To review", request_folder: "/Client uploads",
  rules: [{ match: "invoice", label: "Invoice", folder: "/Finance/Supplier invoices" }],
  checklist: [{ code: "liability", label: "Public liability certificate", match: "liability", within_days: 365, folder: "/Compliance/Certificates" }],
};
const moves = () => hits.filter((h) => h.path.endsWith("/files/move_v2"));
const requests = () => hits.filter((h) => h.path.endsWith("/file_requests/create"));

beforeEach(() => {
  fake();
  Object.assign(process.env, { DROPBOX_ACCESS_TOKEN: "dbx-test", KIT_ALLOW_WRITES: "1" });
});

test("crons only read and file inside Dropbox; no cron sends a file request", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, noop);
  await CRONS.intake(ctx); await CRONS.file(ctx); await CRONS.chase(ctx);
  assert.equal(requests().length, 0);
  const draftPaths = new Set(["files/list_folder", "files/get_metadata", "files/create_folder_v2", "files/move_v2"]);
  for (const h of hits) assert.ok(draftPaths.has(h.path.replace(/^\/2\//, "")), `unexpected call ${h.path}`);
});

test("file: a rule match is renamed and filed, an unmatched file goes to review", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, noop);
  await CRONS.intake(ctx); await CRONS.file(ctx);
  const byFrom = Object.fromEntries(moves().map((h) => [h.body.from_path, h.body]));
  assert.equal(byFrom["id:AAA111"].to_path, "/Finance/Supplier invoices/2026-11-06_Invoice_Supplier invoice May.pdf");
  assert.equal(byFrom["id:AAA111"].autorename, true);
  assert.equal(byFrom["id:BBB222"].to_path, "/Intake/To review/Mystery scan.pdf");
  assert.ok(folders.has("/Finance/Supplier invoices"));
  assert.equal((await store.get<any>("documents", "id:AAA111"))?.status, "filed");
  assert.equal((await store.get<any>("documents", "id:BBB222"))?.status, "review");
});

test("chase queues a file request for approval, once, and the approval sends it", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, noop);
  await CRONS.intake(ctx); await CRONS.file(ctx);
  await CRONS.chase(ctx); await CRONS.chase(ctx);
  assert.equal(requests().length, 0, "a cron must not send the request");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "a second run must not queue the same request again");
  assert.equal(pending[0].status, "pending");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].body.destination, "/Client uploads");
  assert.equal(requests()[0].body.title, "Please send: Public liability certificate");
});

test("a draft run refuses a live operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, noop);
  await assert.rejects(ctx.draft({ platform: "dropbox", op: "file_requests.create", summary: "x" }), /not a draft operation/);
});

test("chase: a file the client named, that no rule filed into the checklist folder, does not satisfy the checklist", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, noop);
  await CRONS.intake(ctx); await CRONS.file(ctx);
  assert.equal((await store.get<any>("documents", "id:CCC333"))?.status, "review");
  await CRONS.chase(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "the request is queued: a name alone is not a certificate");
});

test("chase: a checklist item with no safe folder stops the run before anything is queued", async () => {
  const store = new MemoryStore();
  const bad = { ...S, checklist: [{ code: "liability", label: "Public liability certificate", match: "liability", within_days: 365 }] } as unknown as Settings;
  await assert.rejects(CRONS.chase(context(WF, bad, store, NOW, noop)), /not a safe Dropbox folder path/);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0);
});

test("a bad rule folder stops the file run before any move", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, S, store, NOW, noop);
  await CRONS.intake(ctx);
  const bad = { ...S, rules: [{ match: "invoice", label: "Invoice", folder: "/../etc" }] };
  await assert.rejects(CRONS.file(context(WF, bad, store, NOW, noop)), /not a safe Dropbox folder path/);
  assert.equal(moves().length, 0);
});
