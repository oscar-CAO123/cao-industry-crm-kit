// Returns workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { clearTokenCache } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft } from "../industries/retail/workflows/customer-service/x-returns/index.ts";
import type { Settings } from "../industries/retail/workflows/customer-service/x-returns/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/retail/workflows/customer-service/x-returns/workflow.json", "utf8")) as WorkflowRecord;
const S: Settings = { business_name: "Test Store", intake: ["google-workspace", "gorgias"], return_form_url: "https://example.com.au/returns" };
const NOW = new Date("2026-11-09T00:00:00Z");
type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/token")) return json({ access_token: "g-tok", expires_in: 3600 });
      // Gmail
      if (p === "/gmail/v1/users/me/messages" && m === "GET") return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (p === "/gmail/v1/users/me/messages/m1") return json({ id: "m1", threadId: "t1", internalDate: "1762560000000", payload: { headers: [
        { name: "From", value: "Ari Lee <ari@example.com>" }, { name: "Subject", value: "Return my jacket" }] } });
      if (p === "/gmail/v1/users/me/messages/m2") return json({ id: "m2", threadId: "t2", internalDate: "1762560000000", payload: { headers: [
        { name: "From", value: "not an address" }, { name: "Subject", value: "Refund please" }] } });
      if (p === "/gmail/v1/users/me/drafts" && m === "POST") return json({ id: "d1" });
      if (p === "/gmail/v1/users/me/drafts/send" && m === "POST") return json({ id: "sent1" });
      // Gorgias
      if (p === "/api/tickets" && m === "GET") return json({ data: [
        { id: 101, subject: "Return request for order 5", created_datetime: "2026-11-08T00:00:00Z" },
        { id: 102, subject: "Store opening hours", created_datetime: "2026-11-08T01:00:00Z" }] });
      if (p === "/api/tickets/101/messages" && m === "POST") return json({ id: 9001 });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const posted = () => hits.filter((h) => h.method === "POST" && (h.path.endsWith("/drafts/send") || /\/api\/tickets\/\d+\/messages$/.test(h.path)));

beforeEach(() => {
  fake();
  clearTokenCache();
  const tokens = new MemoryTokenStore();
  setTokenStore(tokens);
  Object.assign(process.env, { GOOGLE_MAILBOX: "owner@example.com", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs",
    GORGIAS_DOMAIN: "acme", GORGIAS_EMAIL: "ops@example.com", GORGIAS_API_KEY: "k", KIT_ALLOW_WRITES: "1" });
  tokens.set("google.refresh_token.owner_example.com", "r1");
});

test("crons never send: intake and draft reach no send or ticket reply", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 3 });
  assert.deepEqual(await draft(ctx), { queued: 2, failed: 1 });
  assert.equal(posted().length, 0, "nothing sent or posted by a cron");
});

test("a reply is queued for approval, a re-run never queues it twice, and an unusable sender is left alone", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 2, "one Gmail send and one Gorgias reply");
  assert.deepEqual(pending.map((a) => a.acts[0].op).sort(), ["docs.post_tickets_ticket_id_messages", "gmail.users.drafts.send"]);
  assert.equal(await intake(ctx).then((r) => r.added), 0, "re-running intake adds nothing");
  await draft(ctx);
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 2, "re-running draft never queues twice");
  assert.equal(hits.filter((h) => h.path === "/gmail/v1/users/me/drafts").length, 1, "one Gmail draft created");
});

test("approving the Gmail reply sends the draft; the draft carries only the business's text", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const draftBody = hits.find((h) => h.path === "/gmail/v1/users/me/drafts")!.body;
  const mail = Buffer.from(draftBody.message.raw, "base64url").toString("utf8");
  assert.match(mail, /To: ari@example\.com/);
  assert.match(mail, /Subject: Re: Return my jacket/);
  assert.match(mail, /https:\/\/example\.com\.au\/returns/);
  assert.doesNotMatch(mail, /Refund please/, "customer text is never copied into the reply");
  const gmailAp = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "gmail.users.drafts.send")!;
  const ap = await approve(WF, store, gmailAp.id, "owner", NOW);
  assert.equal(ap.status, "done");
  const sent = hits.find((h) => h.path === "/gmail/v1/users/me/drafts/send")!;
  assert.deepEqual(sent.body, { id: "d1" });
  await assert.rejects(approve(WF, store, gmailAp.id, "owner"), /already done/);
});

test("approving the Gorgias reply posts it on the ticket as an agent reply", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx); await draft(ctx);
  const ticketAp = Object.values(await store.list<Approval>("approvals")).find((a) => a.acts[0].op === "docs.post_tickets_ticket_id_messages")!;
  const ap = await approve(WF, store, ticketAp.id, "owner", NOW);
  assert.equal(ap.status, "done");
  const post = hits.find((h) => h.path === "/api/tickets/101/messages")!;
  assert.equal(post.body.from_agent, true);
  assert.equal(post.body.channel, "email");
  assert.match(post.body.body_text, /https:\/\/example\.com\.au\/returns/);
});

test("a draft operation cannot send and a cron cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "gmail.users.drafts.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "gorgias", op: "docs.get_tickets", summary: "x" }), /not a live operation/);
});

test("the reply refuses a non-https returns link before anything is drafted", async () => {
  const store = new MemoryStore();
  await intake(context(WF, S, store, NOW, () => {}));
  const bad = { ...S, return_form_url: "http://example.com/returns" };
  await assert.rejects(draft(context(WF, bad, store, NOW, () => {})), /https link/);
  assert.equal(hits.filter((h) => h.path === "/gmail/v1/users/me/drafts").length, 0);
});
