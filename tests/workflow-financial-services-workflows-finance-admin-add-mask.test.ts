// Add-mask workflow tests. Every request goes to a fake network: no test reaches a real Dropbox account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/financial-services/workflows/finance-admin/add-mask/index.ts";
import type { Settings } from "../industries/financial-services/workflows/finance-admin/add-mask/types.ts";
import fs from "node:fs";
import path from "node:path";

const WF = JSON.parse(fs.readFileSync(path.join(process.cwd(), "industries/financial-services/workflows/finance-admin/add-mask/workflow.json"), "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const noop = () => {};
const RAW = "/Client files/To mask", MASKED = "/Client files/Masked";

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let members: Record<string, { email: string; invitee?: boolean }[]>;

const ENTRIES_RAW = [
  { ".tag": "file", id: "id:RAW001", name: "Passport copy J Smith.pdf", path_display: `${RAW}/Passport copy J Smith.pdf`, server_modified: "2026-11-06T09:00:00Z" },
  { ".tag": "folder", id: "id:FOLD01", name: "Archive", path_display: `${RAW}/Archive` },
  { ".tag": "file", id: "not an id", name: "Odd.pdf", path_display: `${RAW}/Odd.pdf` },
];
const ENTRIES_MASKED = [
  { ".tag": "file", id: "id:MSK001", name: "Application masked.pdf", path_display: `${MASKED}/Application masked.pdf` },
];

function fake() {
  hits = [];
  members = {
    "id:MSK001": [{ email: "owner@example.com.au" }, { email: "lender@example.com" }],
  };
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith("/files/list_folder")) {
        if (body?.path === RAW) return json({ entries: ENTRIES_RAW, has_more: false, cursor: "c" });
        if (body?.path === MASKED) return json({ entries: ENTRIES_MASKED, has_more: false, cursor: "c" });
        return json({ entries: [], has_more: false, cursor: "c" });
      }
      if (p.endsWith("/sharing/list_file_members")) {
        const list = members[body?.file] ?? [];
        return json({
          users: list.filter((x) => !x.invitee).map((x) => ({ access_type: { ".tag": "owner" }, user: { account_id: "dbid:x", email: x.email, display_name: x.email } })),
          groups: [],
          invitees: list.filter((x) => x.invitee).map((x) => ({ access_type: { ".tag": "viewer" }, invitee: { ".tag": "email", email: x.email } })),
          cursor: undefined,
        });
      }
      if (p.endsWith("/sharing/add_file_member")) {
        const email = body.members[0].email;
        (members[body.file] ??= []).push({ email });
        return json([{ member: { ".tag": "email", email }, result: { ".tag": "success", access_type: { ".tag": "viewer" } } }]);
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const adds = () => hits.filter((h) => h.path.endsWith("/sharing/add_file_member"));
const SETTINGS: Settings = {
  owner_email: "owner@example.com.au", raw_folder: RAW, masked_folder: MASKED,
  recipients: [{ email: "lender@example.com" }, { email: "valuer@example.com" }],
};

beforeEach(() => {
  fake();
  Object.assign(process.env, { DROPBOX_ACCESS_TOKEN: "dbx-test", KIT_ALLOW_WRITES: "1" });
});

test("crons only read and queue: no cron calls a share directly", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, noop);
  await CRONS.intake(ctx); await CRONS.share(ctx); await CRONS.check(ctx);
  assert.equal(adds().length, 0, "nothing shared by a cron");
  const allowed = new Set(["files/list_folder", "sharing/list_file_members"]);
  for (const h of hits) assert.ok(allowed.has(h.path.replace(/^\/2\//, "")), `unexpected call ${h.path}`);
});

test("intake records each new file once, skipping folders and malformed ids", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, noop);
  assert.deepEqual(await CRONS.intake(ctx), { added: 1, has_more: false });
  assert.deepEqual(await CRONS.intake(ctx), { added: 0, has_more: false }, "a second run adds nothing");
  const raw = await store.list<RawFile>("raw");
  assert.deepEqual(Object.keys(raw), ["id:RAW001"]);
  assert.equal(raw["id:RAW001"].status, "new");
});

type RawFile = { status: string };

test("share queues one approval per missing recipient, once; approval shares quietly as a viewer", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, noop);
  assert.deepEqual(await CRONS.share(ctx), { queued: 1 }, "only valuer is missing");
  await CRONS.share(ctx);
  assert.equal(adds().length, 0, "a cron does not share");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "a second run never queues the same share");
  assert.equal(pending[0].status, "pending");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(adds().length, 1);
  const body = adds()[0].body;
  assert.equal(body.file, "id:MSK001");
  assert.deepEqual(body.members, [{ ".tag": "email", email: "valuer@example.com" }]);
  assert.deepEqual(body.access_level, { ".tag": "viewer" });
  assert.equal(body.quiet, true, "Dropbox sends no invitation");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("share queues nothing for a recipient who can already see the copy", async () => {
  members["id:MSK001"].push({ email: "valuer@example.com", invitee: true });
  const store = new MemoryStore();
  assert.deepEqual(await CRONS.share(context(WF, SETTINGS, store, NOW, noop)), { queued: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("check records who can see each masked copy and flags anyone not approved; the owner is not flagged", async () => {
  members["id:MSK001"].push({ email: "stranger@example.net" });
  const store = new MemoryStore();
  assert.deepEqual(await CRONS.check(context(WF, SETTINGS, store, NOW, noop)), { checked: 1, flagged: 1 });
  const rec = await store.get<{ unexpected: string[]; members: string[] }>("masked", "id:MSK001");
  assert.deepEqual(rec?.unexpected, ["stranger@example.net"]);
  assert.ok(rec?.members.includes("owner@example.com.au"));
  assert.equal(adds().length, 0, "check changes nothing");
});

test("a draft run refuses the share operation", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, noop);
  await assert.rejects(ctx.draft({ platform: "dropbox", op: "sharing.add_file_member", summary: "x" }), /not a draft operation/);
});

test("a malformed recipient stops the run before any call is made", async () => {
  const bad = { ...SETTINGS, recipients: [{ email: "not an email" }] };
  await assert.rejects(CRONS.share(context(WF, bad, new MemoryStore(), NOW, noop)), /is not a valid email address/);
  assert.equal(hits.length, 0);
});

test("a folder path that is not safe stops the run before any call is made", async () => {
  const bad = { ...SETTINGS, masked_folder: "/../etc" };
  await assert.rejects(CRONS.check(context(WF, bad, new MemoryStore(), NOW, noop)), /not a safe Dropbox folder path/);
  assert.equal(hits.length, 0);
});
