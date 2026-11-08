// Guests and waitlist workflow tests. Every request goes to a fake network: no test reaches a real Google account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { refreshKey, clearTokenCache } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { queue, close } from "../industries/hospitality/workflows/customer-service/x-guests/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/hospitality/workflows/customer-service/x-guests/workflow.json", "utf8")) as WorkflowRecord;
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", MAILBOX = "owner@example.com.au";
const HEAD = ["Guest", "Party size", "Added", "Quoted wait (min)", "Position", "Status", "Outcome time", "Note"];
const S: any = { business_name: "Test Venue", timezone: "Australia/Sydney", minutes_per_group: 15, google_workspace: { spreadsheet_id: SHEET } };
const NOW = new Date("2026-12-05T10:00:00Z");

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let grid: unknown[][] = [];
let appended: unknown[][] = [];

function fake() {
  hits = []; grid = [HEAD]; appended = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = decodeURIComponent(u.pathname);
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.search, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "tok", expires_in: 3600 });
      if (p.startsWith("/v4/spreadsheets/")) {
        if (p.endsWith(":append")) { appended.push(...body.values); return json({ updates: {} }); }
        const clear = p.match(/\/values\/Waitlist!A(\d+):H\d+:clear$/);
        if (m === "POST" && clear) { grid[Number(clear[1]) - 1] = []; return json({}); }
        const row = p.match(/\/values\/Waitlist!A(\d+):H\d+$/);
        if (m === "PUT" && row) { grid[Number(row[1]) - 1] = [...body.values[0]]; return json({}); }
        if (m === "GET") return json({ range: "Waitlist", values: grid });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const line = (o: Partial<Record<"guest" | "party" | "added" | "quoted" | "position" | "status" | "outcome" | "note", string | number>>): unknown[] =>
  [o.guest ?? "", o.party ?? "", o.added ?? "", o.quoted ?? "", o.position ?? "", o.status ?? "", o.outcome ?? "", o.note ?? ""];
const ARI = { guest: "Ari Lee", party: 2, added: "2026-12-05T18:00:00+11:00", status: "Waiting" };
const SAM = { guest: "Sam Cho", party: 4, added: "2026-12-05T18:05:00+11:00", status: "Waiting" };
const writes = () => hits.filter((h) => h.method === "PUT");
const clears = () => hits.filter((h) => h.path.endsWith(":clear"));

beforeEach(() => {
  fake(); clearTokenCache();
  const tokens = new MemoryTokenStore(); setTokenStore(tokens);
  tokens.values.set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("queue: waiting parties get a position and a quoted wait, written back to the sheet, and nothing is cleared", async () => {
  grid.push(line(SAM), line(ARI));                                    // added out of order on purpose
  assert.deepEqual(await queue(context(WF, S, new MemoryStore(), NOW, () => {})), { positioned: 2, check: 0 });
  assert.equal(grid[1][0], "Sam Cho");
  assert.equal(grid[1][4], 2, "Sam is second");
  assert.equal(grid[1][3], 15, "Sam quoted 15 minutes");
  assert.equal(grid[2][4], 1, "Ari is first");
  assert.equal(grid[2][3], 0, "Ari quoted 0 minutes");
  assert.equal(clears().length, 0, "a cron never clears a row");
  assert.equal(hits.some((h) => /gmail|calendar/.test(h.path)), false, "a cron never touches mail or the calendar");
});

test("queue: a second run writes nothing new", async () => {
  grid.push(line(ARI));
  await queue(context(WF, S, new MemoryStore(), NOW, () => {}));
  const before = writes().length;
  assert.deepEqual(await queue(context(WF, S, new MemoryStore(), NOW, () => {})), { positioned: 0, check: 0 });
  assert.equal(writes().length, before);
});

test("queue: a waiting row without a guest name or a valid time is marked Check and holds no place in the queue", async () => {
  grid.push(line({ ...ARI, guest: "" }), line(SAM));
  assert.deepEqual(await queue(context(WF, S, new MemoryStore(), NOW, () => {})), { positioned: 1, check: 1 });
  assert.equal(grid[1][5], "Check");
  assert.match(String(grid[1][7]), /guest name/);
  assert.equal(grid[2][4], 1, "the next valid party moves up to first");
});

test("queue: a status that is not on the list is marked Check", async () => {
  grid.push(line({ ...ARI, status: "Waitng" }));
  assert.deepEqual(await queue(context(WF, S, new MemoryStore(), NOW, () => {})), { positioned: 0, check: 1 });
  assert.equal(grid[1][5], "Check");
});

test("queue: text from the sheet is escaped before it is written back", async () => {
  grid.push(line({ ...ARI, guest: '=HYPERLINK("https://example.com")' }));
  await queue(context(WF, S, new MemoryStore(), NOW, () => {}));
  assert.equal(String(grid[1][0]).startsWith("'="), true);
});

test("queue: a tab whose header differs is refused before any row is read", async () => {
  grid = [["Name", "Party", "Added", "Wait", "Place", "Status", "Out", "Note"], line(ARI)];
  await assert.rejects(queue(context(WF, S, new MemoryStore(), NOW, () => {})), /must start with these columns/);
  assert.equal(writes().length, 0);
});

test("close: a seated party is logged once with its minutes waited, and its row is queued for clearing, not cleared", async () => {
  grid.push(line({ ...ARI, quoted: 0, position: 1, status: "Seated", outcome: "2026-12-05T18:20:00+11:00" }));
  const store = new MemoryStore();
  assert.deepEqual(await close(context(WF, S, store, NOW, () => {})), { logged: 1, queued: 1, skipped: 0 });
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1], "Ari Lee");
  assert.equal(appended[0][4], "Seated");
  assert.equal(appended[0][5], 20, "minutes waited");
  assert.equal(clears().length, 0, "nothing cleared by the cron");
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].acts[0].op, "sheets.spreadsheets.values.clear");
});

test("close: a second run logs nothing new and does not queue a second clear", async () => {
  grid.push(line({ ...ARI, status: "No show" }));
  const store = new MemoryStore();
  await close(context(WF, S, store, NOW, () => {}));
  assert.deepEqual(await close(context(WF, S, store, NOW, () => {})), { logged: 0, queued: 1, skipped: 0 });
  assert.equal(appended.length, 1, "logged once");
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
});

test("close: a row that is waiting is left alone", async () => {
  grid.push(line(ARI));
  assert.deepEqual(await close(context(WF, S, new MemoryStore(), NOW, () => {})), { logged: 0, queued: 0, skipped: 0 });
  assert.equal(appended.length, 0);
});

test("approval clears the row after it is logged, and a second approval is refused", async () => {
  grid.push(line({ ...ARI, status: "Left", outcome: "2026-12-05T18:30:00+11:00" }));
  const store = new MemoryStore();
  await close(context(WF, S, store, NOW, () => {}));
  const [ap0] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap0.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(clears().length, 1);
  assert.deepEqual(grid[1], [], "the row is cleared");
  await assert.rejects(approve(WF, store, ap0.id, "owner"), /already done/);
});

test("a cron cannot run the clear: it is a live operation only", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "sheets.spreadsheets.values.clear", input: { params: { spreadsheetId: SHEET, range: "Waitlist!A2:H2" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "google-workspace", op: "sheets.spreadsheets.values.get", summary: "x" }), /not a live operation/);
});
