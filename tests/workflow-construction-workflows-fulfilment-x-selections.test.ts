// Client selections workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, followUp } from "../industries/construction/workflows/fulfilment/x-selections/index.ts";
import fs from "node:fs";

const DIR = "industries/construction/workflows/fulfilment/x-selections";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com";
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const NOW = new Date("2026-11-09T00:00:00Z");
const DAY = 864e5;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let regStatus = "Pack ready";
let drafts = 0;

function register(): string[][] {
  return [
    ["Project", "Client", "Email", "Selection", "Allowance", "Chosen", "Status", "Due"],
    ["12 Ash St", "Sam Lee", "sam@example.com", "Kitchen tiles", "$3,500.00", "", regStatus, "2026-11-20"],
    ["12 Ash St", "Sam Lee", "sam@example.com", "Bathroom taps", "$400.00", "", "Chosen", "2026-11-20"],
    ["", "No project", "x@example.com", "", "", "", "Pack ready", ""],
  ];
}

function fake() {
  hits = []; regStatus = "Pack ready"; drafts = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", expires_in: 1800 });
      if (p.includes("/v4/spreadsheets/") && p.includes("/values/") && m === "GET") return json({ values: register().map((r, i) => (i === 1 ? [...r.slice(0, 6), regStatus, r[7]] : r)) });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") { drafts++; return json({ id: `d${drafts}`, message: { id: `m${drafts}` } }); }
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "sent1" });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const sends = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts/send");
const drafted = () => hits.filter((h) => h.path === "/gmail/v1/users/me/drafts" && h.method === "POST");
const SETTINGS: any = {
  business_name: "Example Builders",
  google: { spreadsheet_id: SHEET, register_range: "Selections!A1:H500" },
  selections: { form_url: "https://example.com/selections-form", followup_after_days: 3, chase_every_days: 3, max_chases: 3, signoff: "Example Builders" },
};

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
  return tokenStore().set(refreshKey(MAILBOX), "r1");
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "sheets.spreadsheets.values.get", summary: "x" }), /not a live operation/);
  assert.equal(hits.filter((h) => h.path.includes("/drafts/send")).length, 0);
});

test("settings: a bad sheet id or a non-https form link is refused before any call", async () => {
  const bad = { ...SETTINGS, google: { ...SETTINGS.google, spreadsheet_id: "../../etc" } };
  await assert.rejects(intake(context(WF, bad, new MemoryStore(), NOW, () => {})), /spreadsheet_id/);
  const http = { ...SETTINGS, selections: { ...SETTINGS.selections, form_url: "http://example.com/form" } };
  await assert.rejects(draft(context(WF, http, new MemoryStore(), NOW, () => {})), /must be https/);
  assert.equal(hits.filter((h) => h.path !== "/token").length, 0);
});

test("intake reads the register, skips rows with no project or selection, and writes nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await intake(context(WF, SETTINGS, store, NOW, () => {})), { seen: 2, added: 2 });
  const st = await store.get<any>("selections", Object.keys(await store.list("selections"))[0]);
  assert.equal(st.row.status, "pack-ready");
  assert.equal(hits.filter((h) => h.method !== "GET" && h.path !== "/token").length, 0, "no write from intake");
});

test("a pack is drafted once, queued, never sent until approved; re-runs never draft or queue it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 1, queued: 1, parked: 0 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const raw = Buffer.from(drafted()[0].body.message.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: sam@example\.com/m);
  assert.match(raw, /https:\/\/example\.com\/selections-form/);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  await intake(ctx); await draft(ctx);
  assert.equal(drafted().length, 1, "re-runs never draft the pack twice");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].body, { id: "d1" });
});

test("a client name carrying a line break cannot add a header to the draft", async () => {
  const hostile = { ...SETTINGS };
  fake();
  const store = new MemoryStore();
  regStatus = "Pack ready";
  const ctx = context(WF, hostile, store, NOW, () => {});
  await intake(ctx);
  const [key] = Object.keys(await store.list("selections"));
  const st = await store.get<any>("selections", key);
  st.row.client = "Sam\r\nBcc: spy@example.com";
  await store.put("selections", key, st);
  await draft(ctx);
  const raw = Buffer.from(drafted()[0].body.message.raw, "base64url").toString("utf8");
  assert.equal(raw.split(/\r?\n/).some((l) => /^Bcc:/i.test(l)), false);
});

test("a row with no valid email is parked, not drafted", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await intake(ctx);
  const [key] = Object.keys(await store.list("selections"));
  const st = await store.get<any>("selections", key);
  st.row.email = "not-an-email";
  await store.put("selections", key, st);
  assert.deepEqual(await draft(ctx), { drafted: 0, queued: 0, parked: 1 });
  assert.equal(drafted().length, 0);
});

test("chases follow only a sent pack, come due on the set days, stop at the maximum, and stop once chosen", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  await draft(context(WF, SETTINGS, store, NOW, () => {}));
  const [pack] = Object.values(await store.list<Approval>("approvals"));
  regStatus = "Awaiting choice";
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(NOW.getTime() + 4 * DAY), () => {})), { queued: 0 }, "pack not sent yet");
  await approve(WF, store, pack.id, "owner", NOW);
  const at = (d: number) => context(WF, SETTINGS, store, new Date(NOW.getTime() + d * DAY), () => {});
  assert.deepEqual(await followUp(at(2)), { queued: 0 }, "first chase not due");
  assert.deepEqual(await followUp(at(4)), { queued: 1 }, "first chase due after 3 days");
  assert.deepEqual(await followUp(at(5)), { queued: 0 }, "not again the next day");
  assert.deepEqual(await followUp(at(7)), { queued: 1 }, "second chase every 3 days");
  assert.deepEqual(await followUp(at(11)), { queued: 1 }, "third chase");
  assert.deepEqual(await followUp(at(30)), { queued: 0 }, "no fourth chase: maximum reached");
  assert.equal(drafted().length, 4, "one pack draft and three chase drafts");
  regStatus = "Chosen";
  await intake(at(31));
  assert.deepEqual(await followUp(at(40)), { queued: 0 }, "no chase once chosen");
});

test("deploy gate: a draft that needs a write is blocked when the deploy does not allow writes", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.create", input: { params: { userId: "me" }, body: { message: { raw: "x" } } }, summary: "x" }));
  assert.equal(drafted().length, 0);
});
