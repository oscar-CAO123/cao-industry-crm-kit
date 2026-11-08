// Conflict check workflow tests. Every request goes to a fake network: no test reaches a real practice.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, check, openMatter } from "../industries/professional-services/workflows/compliance-safety/add-conflict/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/compliance-safety/add-conflict/workflow.json", "utf8")) as WorkflowRecord;
const S: any = { business_name: "Test Law", search_limit: 20 };
const NOW = new Date("2026-11-09T00:00:00Z");

// Two leads. LEAD_HIT has a party whose name matches an existing contact (C9). LEAD_CLEAR has no name matches.
const LEAD_HIT = "11111111-2222-4333-8444-555555555555", LEAD_CLEAR = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const names: Record<string, string> = { C1: "Jo Smith", C2: "Alex Brown", C3: "Pat Smith", C4: "Kim Lee", C9: "Jo Smith" };
type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];

function person(id: string) { const [first, last] = names[id].split(" "); return { id, person: { firstName: first, lastName: last } }; }

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/matters" && m === "GET") return json({ value: [{ id: LEAD_HIT, title: "Smith estate" }, { id: LEAD_CLEAR, title: "Lee trust" }] });
      if (p === `/matters/${LEAD_HIT}/roles`) return json({ roles: [{ id: "R1", isClient: true, contact: { id: "C1" } }, { id: "R2", isOtherSide: true, contact: { id: "C2" } }] });
      if (p === `/matters/${LEAD_CLEAR}/roles`) return json({ roles: [{ id: "R4", isClient: true, contact: { id: "C4" } }] });
      if (/\/matters\/[^/]+\/roles\/R1\/relationships$/.test(p)) return json({ relationships: [{ id: "L1", contact: { id: "C3" } }] });
      if (/\/matters\/[^/]+\/roles\/(R2|R4)\/relationships$/.test(p)) return json({ relationships: [] });
      if (p.startsWith("/contacts/")) return json(person(p.split("/")[2]));
      if (p === "/contacts" && m === "GET") {
        const q = u.searchParams.get("Search") ?? "";
        if (q === "Jo Smith") return json({ value: [person("C1"), person("C9")] });   // C1 is the lead's own client, C9 is a real match
        if (q === "Pat Smith") return json({ value: [person("C3")] });                 // the lead's own related party
        return json({ value: [] });
      }
      if (p.startsWith("/matters/") && m === "PATCH") return json({});
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SMOKEBALL_ACCESS_TOKEN: "tok", SMOKEBALL_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation, and a read is the only draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "smokeball", op: "PatchMatter", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "smokeball", op: "GetContacts", summary: "x" }), /not a live operation/);
});

test("crons read and record only: no write reaches the practice system", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.deepEqual(await check(ctx), { clear: 1, hit: 1, no_parties: 0 });
  assert.equal(writes().length, 0, "nothing written by intake or check");
  const hit = await store.get<any>("leads", LEAD_HIT);
  assert.equal(hit.status, "hit");
  assert.deepEqual(hit.hits.map((h: any) => h.contact_id), ["C9"], "the lead's own parties are not counted as matches");
});

test("a clear lead is queued to open as a matter, never opened by a cron", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await check(ctx);
  assert.deepEqual(await openMatter(ctx), { queued: 1 });
  assert.equal(writes().length, 0, "queuing does not touch the practice system");
  const queued = await store.get<Approval>("approvals", approvalId(WF.id, `open:${LEAD_CLEAR}`));
  assert.equal(queued?.status, "pending");
  assert.equal(queued?.acts[0].op, "PatchMatter");
  assert.equal(await store.get("approvals", approvalId(WF.id, `open:${LEAD_HIT}`)), undefined, "a lead with a match is never queued");
});

test("re-runs never queue twice, and an approved open is a single PATCH", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await check(ctx); await openMatter(ctx);
  await intake(ctx); await check(ctx); await openMatter(ctx);
  const pending = Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "re-runs never queue the same open twice");
  const ap = await approve(WF, store, pending[0].id, "partner", NOW);
  assert.equal(ap.status, "done");
  const patch = writes().filter((h) => h.method === "PATCH");
  assert.equal(patch.length, 1);
  assert.equal(patch[0].path, `/matters/${LEAD_CLEAR}`);
  assert.deepEqual(patch[0].body, { isLead: false });
  await openMatter(ctx);
  assert.equal((await store.get<any>("leads", LEAD_CLEAR)).status, "opened");
  await assert.rejects(approve(WF, store, pending[0].id, "partner"), /already done/);
});
