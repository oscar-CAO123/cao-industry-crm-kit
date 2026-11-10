// Contracts workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, review, followUp, CRONS } from "../industries/professional-services/workflows/compliance-safety/contracts/index.ts";
import type { Contract } from "../industries/professional-services/workflows/compliance-safety/contracts/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/compliance-safety/contracts/workflow.json", "utf8")) as WorkflowRecord;
const ACC = "1f2e3d4c-0000-4000-8000-000000000001";
const ENV = "11111111-2222-4333-8444-555555555555";
const PRIVATE_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;

type Hit = { method: string; host: string; path: string; body: any };
let hits: Hit[] = [];
let envelopes: any[] = [];
let received = "2026-11-08T00:00:00Z";
let rowsFail = false;

function fake() {
  hits = []; received = "2026-11-08T00:00:00Z"; rowsFail = false;
  envelopes = [{ envelopeId: ENV, status: "sent", emailSubject: "Retainer agreement", sentDateTime: "2026-11-01T00:00:00Z",
    recipients: { signers: [
      { name: "Sam Lee", email: "Sam@Example.com", status: "sent", routingOrder: "1", recipientId: "1" },
      { name: "Pat Doe", email: "pat@example.com", status: "completed", signedDateTime: "2026-11-02T00:00:00Z", routingOrder: "2", recipientId: "2" },
    ] } }];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.hostname, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      // DocuSign sign-in (demo sandbox) and the account's API host
      if (u.hostname === "account-d.docusign.com" && p === "/oauth/token") return json({ access_token: "ds-token", expires_in: 3600 });
      if (u.hostname === "account-d.docusign.com" && p === "/oauth/userinfo") return json({ accounts: [{ account_id: ACC, base_uri: "https://demo.docusign.net" }] });
      if (u.hostname === "demo.docusign.net" && p.endsWith("/envelopes") && m === "GET") return json({ envelopes });
      // Microsoft Graph
      if (u.hostname === "graph.microsoft.com") {
        if (/\/mailFolders\/[^/]+\/messages$/.test(p) && m === "GET") return json({ value: [{ id: "AAMkReq1", subject: "Contract for the retainer",
          from: { emailAddress: { name: "Ari", address: "ari@example.com" } }, receivedDateTime: received, hasAttachments: true }] });
        if (p.endsWith("/attachments") && m === "GET") return json({ value: [{ id: "att1", name: "Retainer.pdf", size: 20480, contentType: "application/pdf" }] });
        if (/\/messages$/.test(p) && m === "POST") return json({ id: `AAMkDraft${hits.filter((h) => /\/messages$/.test(h.path) && h.method === "POST").length}` });
        if (/\/messages\/[^/]+\/send$/.test(p) && m === "POST") return new Response(null, { status: 202 });
        if (p.endsWith("/rows") && m === "POST") return rowsFail ? new Response("{}", { status: 400 }) : json({ index: 0 });
      }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/messages\/[^/]+\/send$/.test(h.path));
const drafts = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const rows = () => hits.filter((h) => h.method === "POST" && h.path.endsWith("/rows"));

const S: any = { business_name: "Test Advisory", owner_email: "owner@example.com",
  microsoft_365: { mailbox: "contracts@example.com", folder: "inbox", search: "contract", register: { drive: "DRIVE1", item: "ITEM1", table: "Contracts" } },
  docusign: { from_days: 90 }, follow_up: { after_days: [3, 7] } };
const NOW = new Date("2026-11-08T00:00:00Z");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { M365_ACCESS_TOKEN: "ms", DOCUSIGN_ENV: "demo", DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_USER_ID: "uid",
    DOCUSIGN_ACCOUNT_ID: ACC, DOCUSIGN_PRIVATE_KEY: PRIVATE_KEY, KIT_ALLOW_WRITES: "1" });
});

test("runtime: a draft cannot run a live operation and a cron cannot queue a draft one", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "microsoft-365", op: "users.user.messages.message.send", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "microsoft-365", op: "users.CreateMessages", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "docusign", op: "esignature.Envelopes_PutEnvelope", summary: "x" }), /not a draft operation/);
});

test("cron entries match the workflow's crons", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("contract email: logged once, a review note drafted and queued, nothing sent until approved", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, S, store, NOW, () => {});
  assert.deepEqual(await intake(ctx()), { added: 1 });
  assert.deepEqual(await intake(ctx()), { added: 0 }, "a re-run logs nothing twice");
  assert.deepEqual(await review(ctx()), { drafted: 1 });
  assert.equal(sends().length, 0, "nothing sent by a cron");
  assert.equal(drafts().length, 1, "one review note drafted");
  assert.equal(rows().length, 1, "one register row");
  const [contract] = Object.values(await store.list<Contract>("contracts"));
  assert.equal(contract.status, "in-review");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.deepEqual(pending[0].acts.map((a) => a.op), ["users.user.messages.message.send"]);
  await review(ctx());
  await intake(ctx());
  assert.equal(drafts().length, 1, "re-runs draft nothing new");
  assert.equal(rows().length, 1, "re-runs add no register row");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "re-runs never queue twice");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(sends().length, 1, "sent once, only after approval");
  await assert.rejects(approve(WF, store, pending[0].id, "owner"), /already done/);
});

test("a failed register row never drafts the review note a second time", async () => {
  const store = new MemoryStore();
  const ctx = () => context(WF, S, store, NOW, () => {});
  await intake(ctx());
  rowsFail = true;
  await assert.rejects(review(ctx()), /failed with status 400/);
  assert.equal(drafts().length, 1, "the note is drafted once before the row fails");
  rowsFail = false;
  assert.deepEqual(await review(ctx()), { drafted: 1 });
  assert.equal(drafts().length, 1, "the retry reuses the saved draft: no second note");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1, "one approval queued");
  const [contract] = Object.values(await store.list<Contract>("contracts"));
  assert.equal(contract.status, "in-review");
});

test("the register row escapes a received date that could read as a formula", async () => {
  received = "=HYPERLINK(\"http://x\")";
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await intake(ctx);
  await review(ctx);
  assert.equal(rows()[0].body.values[0][0], "'=HYPERLINK");
});

test("DocuSign: an unsigned signer gets a reminder on the schedule, re-runs never double-queue, nothing sent by a cron", async () => {
  const store = new MemoryStore();
  const ctx = (at: Date) => context(WF, S, store, at, () => {});
  assert.deepEqual(await followUp(ctx(NOW)), { queued: 1 }, "Sam is unsigned, Pat has completed");
  assert.equal(sends().length, 0, "nothing sent by a cron");
  const [first] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(first.acts[0].op, "users.user.messages.message.send");
  assert.match(first.summary, /sam@example\.com/);
  assert.deepEqual(await followUp(ctx(NOW)), { queued: 0 }, "the same day queues nothing new");
  assert.deepEqual(await followUp(ctx(new Date(NOW.getTime() + 4 * 864e5))), { queued: 1 }, "the second reminder after the gap");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 2);
  await approve(WF, store, first.id, "owner", NOW);
  assert.equal(sends().length, 1);
});

test("follow-up with no DocuSign set queues nothing and calls nothing", async () => {
  const store = new MemoryStore();
  const { docusign, ...rest } = S;
  assert.deepEqual(await followUp(context(WF, rest, store, NOW, () => {})), { queued: 0, note: "docusign is not set for this client" });
  assert.equal(hits.filter((h) => h.host === "demo.docusign.net").length, 0);
});
