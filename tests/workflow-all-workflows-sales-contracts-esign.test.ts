// Contracts e-signature workflow tests. Every request goes to a fake network: no test reaches a real DocuSign account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { clearTokenCache } from "../core/connectors/docusign/client.ts";
import { context, approve, reject, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { prepare, dispatch, status as statusCron } from "../industries/all/workflows/sales/contracts-esign/index.ts";
import { OP_CREATE, OP_READ, OP_SEND } from "../industries/all/workflows/sales/contracts-esign/adapters/docusign.ts";
import type { Agreement } from "../industries/all/workflows/sales/contracts-esign/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/sales/contracts-esign/workflow.json", "utf8")) as WorkflowRecord;
const ACCT = "11111111-2222-4333-8444-555555555555", ENV = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-11-08T00:00:00Z");
const PDF64 = Buffer.from("%PDF-1.4\n% agreement\n").toString("base64");
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
});

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let envStatus = "created";

function fake() {
  hits = []; envStatus = "created";
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/oauth/token") return json({ access_token: "tok", expires_in: 3600 });
      if (p === "/oauth/userinfo") return json({ accounts: [{ account_id: ACCT, base_uri: "https://demo.docusign.net" }] });
      if (p === `/restapi/v2.1/accounts/${ACCT}/envelopes` && m === "POST") return json({ envelopeId: ENV, status: "created" });
      if (p === `/restapi/v2.1/accounts/${ACCT}/envelopes/${ENV}` && m === "GET")
        return json({ envelopeId: ENV, status: envStatus, completedDateTime: envStatus === "completed" ? "2026-11-09T01:00:00Z" : undefined });
      if (p === `/restapi/v2.1/accounts/${ACCT}/envelopes/${ENV}` && m === "PUT") { envStatus = body?.status ?? envStatus; return json({ envelopeId: ENV, status: envStatus }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const posts = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/envelopes"));
const puts = () => hits.filter((h) => h.method === "PUT" && /\/envelopes\/[^/]+$/.test(h.path));

const S: any = { business_name: "Test Agency", email_subject_prefix: "Please sign" };
const agreement = (over: Partial<Agreement> = {}): Agreement => ({
  id: "sale-contract-0001", title: "Property sale contract, 1 Test St", created: NOW.toISOString(), status: "new",
  signers: [{ name: "Sam Lee", email: "sam@example.com" }, { name: "Ari Shah", email: "ari@example.com" }],
  document: { name: "contract.pdf", base64: PDF64 }, ...over,
});
const seeded = async (a: Agreement = agreement()) => {
  const store = new MemoryStore();
  await store.put("agreements", a.id, a);
  return store;
};
const cx = (store: MemoryStore) => context(WF, S, store, NOW, () => {});

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore()); clearTokenCache();
  Object.assign(process.env, { DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_USER_ID: "uid", DOCUSIGN_ACCOUNT_ID: ACCT,
    DOCUSIGN_PRIVATE_KEY: privateKey, DOCUSIGN_ENV: "demo", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot send and a cron cannot queue a draft operation", async () => {
  const ctx = cx(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "docusign", op: OP_SEND, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "docusign", op: OP_CREATE, summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.queue({ platform: "docusign", op: OP_READ, summary: "x" }), /not a live operation/);
  assert.equal(hits.length, 0);
});

test("runtime: writes stay blocked without KIT_ALLOW_WRITES, before any socket opens", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = await seeded();
  await assert.rejects(prepare(cx(store)), WriteBlocked);
  assert.equal(posts().length, 0);
  assert.equal((await store.get<Agreement>("agreements", "sale-contract-0001"))?.status, "new");
});

test("prepare saves the agreement as a created envelope, never sent, and never drafts it twice", async () => {
  const store = await seeded(), ctx = cx(store);
  assert.deepEqual(await prepare(ctx), { drafted: 1, needs_check: 0 });
  const body = posts()[0].body;
  assert.equal(body.status, "created");
  assert.equal(body.emailSubject, "Please sign: Property sale contract, 1 Test St");
  assert.equal(body.documents[0].fileExtension, "pdf");
  assert.deepEqual(body.recipients.signers.map((s: any) => [s.email, s.routingOrder, s.recipientId]), [["sam@example.com", "1", "1"], ["ari@example.com", "2", "2"]]);
  assert.equal(puts().length, 0, "nothing sent by prepare");
  const rec = await store.get<Agreement>("agreements", "sale-contract-0001");
  assert.equal(rec?.status, "drafted");
  assert.equal(rec?.envelope, ENV);
  assert.deepEqual(await prepare(cx(store)), { drafted: 0, needs_check: 0 });
  assert.equal(posts().length, 1, "a second run never creates a second envelope");
});

test("an agreement that fails its checks is held before any DocuSign call", async () => {
  const bad = agreement({ signers: [{ name: "Sam Lee", email: "not-an-email" }] });
  const store = await seeded(bad);
  assert.deepEqual(await prepare(cx(store)), { drafted: 0, needs_check: 1 });
  assert.equal(posts().length, 0);
  const rec = await store.get<Agreement>("agreements", bad.id);
  assert.equal(rec?.status, "needs-check");
  assert.match(rec?.reason ?? "", /signer email/);

  const notPdf = agreement({ id: "sale-contract-0002", document: { name: "x.pdf", base64: Buffer.from("hello").toString("base64") } });
  const s2 = await seeded(notPdf);
  assert.deepEqual(await prepare(cx(s2)), { drafted: 0, needs_check: 1 });
  assert.equal(posts().length, 0);
});

test("dispatch queues the send for approval; nothing goes out until a person approves it", async () => {
  const store = await seeded(), ctx = cx(store);
  await prepare(ctx);
  assert.deepEqual(await dispatch(cx(store)), { queued: 1 });
  assert.equal(puts().length, 0, "a queued send is not sent");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => [a.op, a.input?.body]), [[OP_SEND, { status: "sent" }]]);
  assert.deepEqual(await dispatch(cx(store)), { queued: 0 }, "a second dispatch never queues it again");
  assert.equal(Object.keys(await store.list("approvals")).length, 1);

  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(puts().length, 1);
  assert.equal(puts()[0].body.status, "sent");
  assert.match(puts()[0].path, new RegExp(`/envelopes/${ENV}$`));

  await statusCron(cx(store));
  assert.equal((await store.get<Agreement>("agreements", "sale-contract-0001"))?.status, "sent");
  assert.equal(puts().length, 1, "the status run never sends");
});

test("status follows the envelope to completed and records when; the status run never sends", async () => {
  const store = await seeded(), ctx = cx(store);
  await prepare(ctx); await dispatch(cx(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  await statusCron(cx(store));
  envStatus = "completed";
  assert.deepEqual(await statusCron(cx(store)), { changed: 1 });
  const rec = await store.get<Agreement>("agreements", "sale-contract-0001");
  assert.equal(rec?.status, "completed");
  assert.equal(rec?.completed_at, "2026-11-09T01:00:00Z");
  assert.equal(puts().length, 1);
  assert.ok(hits.every((h) => !(h.method === "PUT" && h.path.includes("/recipients"))), "no reminder was sent");
});

test("a rejected send is held for a person and is never queued again on its own", async () => {
  const store = await seeded();
  await prepare(cx(store)); await dispatch(cx(store));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await reject(WF, store, ap.id, "owner", NOW);
  await statusCron(cx(store));
  const rec = await store.get<Agreement>("agreements", "sale-contract-0001");
  assert.equal(rec?.status, "needs-check");
  assert.match(rec?.reason ?? "", /rejected/);
  assert.deepEqual(await dispatch(cx(store)), { queued: 0 });
  assert.equal(puts().length, 0);
});
