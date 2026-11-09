// What an approval becomes when its send goes wrong. Only a refusal that proves nothing happened is a clean failure;
// a 5xx, a timeout or a dropped connection may have been processed, so the approval waits for a person to check the
// platform and confirm "done" or "retry". A send can never go out twice on its own. Fake network only.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { context, approve, type Approval, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { MemoryStore } from "../core/workflows/store.ts";

const WF: WorkflowRecord = { id: "test-outcomes", name: "outcomes", draft_ops: { telegram: ["getMe"] }, live_ops: { telegram: ["sendMessage"] }, crons: [] };
const NOW = new Date("2026-11-09T00:00:00Z");
let sends = 0;
let answer: number | "drop" | "errors" = 200;
let liveName = "quotes_bot";

beforeEach(() => {
  sends = 0; answer = 200; liveName = "quotes_bot";
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABCdef_test";
  process.env.KIT_ALLOW_WRITES = "1";
  setTransport({
    fetch: (async (url: any, init: any) => {
      if ((init?.method ?? "GET") === "POST" && String(url).endsWith("/sendMessage")) {
        sends++;
        if (answer === "drop") throw new TypeError("fetch failed: socket hang up");
        if (answer === "errors") return new Response(JSON.stringify({ errors: [{ message: "chat not found" }] }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(answer < 300 ? { ok: true, result: { message_id: 7 } } : { ok: false }),
          { status: answer, headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { username: liveName } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404 });
    }) as any,
    sleep: async () => {},
    log: () => {},
  });
});

async function queued(params: Record<string, unknown> = { chat_id: "42", text: "Your quote is ready" }) {
  const store = new MemoryStore(), ctx = context(WF, {}, store, NOW, () => {});
  const id = await ctx.queue({ platform: "telegram", op: "sendMessage", input: { params }, summary: "send the quote" });
  return { store, id };
}

test("a 4xx refusal is a clean failure: approving again sends it again, once", async () => {
  const { store, id } = await queued();
  answer = 400;
  assert.equal((await approve(WF, store, id, "owner", NOW)).status, "failed");
  answer = 200;
  assert.equal((await approve(WF, store, id, "owner", NOW)).status, "done");
  assert.equal(sends, 2);
});

for (const [what, a] of [["a 500", 500], ["a 503", 503], ["a 408 timeout", 408], ["a dropped connection", "drop"]] as const) {
  test(`${what} may have been processed: the approval needs a check and nothing resends on its own`, async () => {
    const { store, id } = await queued();
    answer = a;
    const ap = await approve(WF, store, id, "owner", NOW);
    assert.equal(ap.status, "needs-check");
    assert.equal(ap.results?.at(-1)?.status, "started", "the act stays marked started");
    assert.match(ap.error ?? "", /outcome unknown/);
    answer = 200;
    await assert.rejects(approve(WF, store, id, "owner", NOW), /needs a check/);
    assert.equal(sends, 1, "no second send without a person's confirmation");
  });
}

test("after a check, done skips the act and retry sends it exactly once more", async () => {
  const a = await queued();
  answer = 500;
  await approve(WF, a.store, a.id, "owner", NOW);
  answer = 200;
  assert.equal((await approve(WF, a.store, a.id, "owner", NOW, "done")).status, "done");
  assert.equal(sends, 1, "done: the platform already had it, nothing is sent");

  sends = 0;
  const b = await queued({ chat_id: "43", text: "Second quote" });
  answer = 500;
  await approve(WF, b.store, b.id, "owner", NOW);
  answer = 200;
  assert.equal((await approve(WF, b.store, b.id, "owner", NOW, "retry")).status, "done");
  assert.equal(sends, 2, "retry: one more send, never more");
});

test("blocked writes and bad inputs fail before anything is sent", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const a = await queued();
  const blocked = await approve(WF, a.store, a.id, "owner", NOW);
  assert.equal(blocked.status, "failed");
  assert.equal(sends, 0);

  process.env.KIT_ALLOW_WRITES = "1";
  const b = await queued({ chat_id: "42" }); // text is required
  const bad = await approve(WF, b.store, b.id, "owner", NOW);
  assert.equal(bad.status, "failed");
  assert.equal(bad.results?.length ?? 0, 0, "nothing was marked started");
  assert.equal(sends, 0);
});

test("the approval record never holds a started act after a clean failure", async () => {
  const { store, id } = await queued();
  answer = 422;
  await approve(WF, store, id, "owner", NOW);
  const ap = await store.get<Approval>("approvals", id);
  assert.ok(!(ap?.results ?? []).some((r) => r.status === "started"));
});

test("a check reads the live record first: unchanged sends once, changed sends nothing and closes the approval", async () => {
  const store = new MemoryStore(), ctx = context(WF, {}, store, NOW, () => {});
  const check = { platform: "telegram", op: "getMe", expect: [{ path: "result.username", equals: "quotes_bot" }] };
  const a = await ctx.queue({ platform: "telegram", op: "sendMessage", input: { params: { chat_id: "42", text: "hi" } }, summary: "a", key: "a", check });
  assert.equal((await approve(WF, store, a, "owner", NOW)).status, "done");
  assert.equal(sends, 1);
  const b = await ctx.queue({ platform: "telegram", op: "sendMessage", input: { params: { chat_id: "42", text: "hi" } }, summary: "b", key: "b", check });
  liveName = "renamed_bot";
  const ap = await approve(WF, store, b, "owner", NOW);
  assert.equal(ap.status, "rejected");
  assert.match(ap.error ?? "", /changed after this was queued .*nothing was sent/);
  assert.equal(sends, 1, "no send once the record changed");
});

test("a check must be a read the workflow may draft, with plain paths", async () => {
  const ctx = context(WF, {}, new MemoryStore(), NOW, () => {});
  const act = { platform: "telegram", op: "sendMessage", input: { params: { chat_id: "42", text: "hi" } }, summary: "x" };
  await assert.rejects(ctx.queue({ ...act, check: { platform: "telegram", op: "sendMessage", expect: [{ path: "ok", equals: true }] } }), /check must use a draft/);
  await assert.rejects(ctx.queue({ ...act, check: { platform: "telegram", op: "getMe", expect: [{ path: "a[0]; drop", equals: 1 }] } }), /plain dot paths/);
});

test("a 200 answer that carries errors is a refusal: clean failure, safe to approve again", async () => {
  const { store, id } = await queued();
  answer = "errors";
  assert.equal((await approve(WF, store, id, "owner", NOW)).status, "failed");
  answer = 200;
  assert.equal((await approve(WF, store, id, "owner", NOW)).status, "done");
});

test("logs name operations and ids, never the summary", async () => {
  const lines: string[] = [];
  const ctx = context(WF, {}, new MemoryStore(), NOW, (m) => lines.push(m));
  await ctx.queue({ platform: "telegram", op: "sendMessage", input: { params: { chat_id: "42", text: "hi" } }, summary: "Remind Jane Citizen (jane@example.com)" });
  await ctx.draft({ platform: "telegram", op: "getMe", summary: "check Jane Citizen" });
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.doesNotMatch(l, /Jane|jane@/);
});
