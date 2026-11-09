// What an approval becomes when its send goes wrong. Only a refusal that proves nothing happened is a clean failure;
// a 5xx, a timeout or a dropped connection may have been processed, so the approval waits for a person to check the
// platform and confirm "done" or "retry". A send can never go out twice on its own. Fake network only.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { context, approve, type Approval, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { MemoryStore } from "../core/workflows/store.ts";

const WF: WorkflowRecord = { id: "test-outcomes", name: "outcomes", draft_ops: {}, live_ops: { telegram: ["sendMessage"] }, crons: [] };
const NOW = new Date("2026-11-09T00:00:00Z");
let sends = 0;
let answer: number | "drop" = 200;

beforeEach(() => {
  sends = 0; answer = 200;
  process.env.TELEGRAM_BOT_TOKEN = "123456:ABCdef_test";
  process.env.KIT_ALLOW_WRITES = "1";
  setTransport({
    fetch: (async (url: any, init: any) => {
      if ((init?.method ?? "GET") === "POST" && String(url).endsWith("/sendMessage")) {
        sends++;
        if (answer === "drop") throw new TypeError("fetch failed: socket hang up");
        return new Response(JSON.stringify(answer < 300 ? { ok: true, result: { message_id: 7 } } : { ok: false }),
          { status: answer, headers: { "content-type": "application/json" } });
      }
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
