import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { googleWorkspace } from "../core/sdk/vendor/google-workspace.ts";
import { sendPrepared } from "../core/sdk/call.ts";
import { clearTokenCache as clearGoogleCache, refreshKey } from "../core/connectors/google-workspace/auth.ts";

type Hit = { method: string; url: string; headers: Record<string, string>; body?: string };
let hits: Hit[] = [];
const bypass: string[] = [];

function fakeNetwork(payload: unknown = {}) {
  hits = [];
  setTransport({
    sleep: async () => {},
    log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url));
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
        return Response.json({ access_token: "fake-google-access-token", expires_in: 3600 });
      }
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
      const body = init?.body === undefined ? undefined : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
      hits.push({ method: init?.method ?? "GET", url: String(url), headers: h, body });
      return Response.json(payload);
    }) as any,
  });
}

before(() => {
  const trap = (name: string) => () => { bypass.push(name); throw new Error(`network bypass: ${name}`); };
  for (const [mod, fns] of [[http, ["request", "get"]], [https, ["request", "get"]], [http2, ["connect"]], [net, ["connect", "createConnection"]], [tls, ["connect"]]] as const) {
    for (const f of fns) (mod as any)[f] = trap(f);
  }
  (globalThis as any).fetch = trap("global fetch");
});

beforeEach(async () => {
  fakeNetwork();
  process.env.GOOGLE_MAILBOX = "owner@example.test";
  process.env.GOOGLE_ALLOWED_MAILBOXES = "other@example.test";
  process.env.GOOGLE_CLIENT_ID = "fake-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const tokens = new MemoryTokenStore();
  await tokens.set(refreshKey("owner@example.test"), "fake-refresh-token");
  setTokenStore(tokens);
  clearGoogleCache();
  delete process.env.KIT_ALLOW_WRITES;
});

const only = (): Hit => { assert.equal(hits.length, 1, `expected one gated request, saw ${hits.length}`); return hits[0]; };

test("the six pinned Google discovery clients send reads through the gate", async () => {
  const calls: Array<[string, () => Promise<unknown>, RegExp]> = [
    ["admin", () => googleWorkspace("admin").users.list({ customer: "my_customer", maxResults: 1 }), /admin\.googleapis\.com|www\.googleapis\.com/],
    ["calendar", () => googleWorkspace("calendar").events.list({ calendarId: "primary", maxResults: 1 }), /www\.googleapis\.com|calendar\.googleapis\.com/],
    ["docs", () => googleWorkspace("docs").documents.get({ documentId: "doc-1" }), /docs\.googleapis\.com/],
    ["drive", () => googleWorkspace("drive").files.list({ pageSize: 1 }), /www\.googleapis\.com|drive\.googleapis\.com/],
    ["gmail", () => googleWorkspace("gmail").users.messages.list({ userId: "me", maxResults: 1 }), /gmail\.googleapis\.com/],
    ["sheets", () => googleWorkspace("sheets").spreadsheets.values.get({ spreadsheetId: "sheet-1", range: "A1" }), /sheets\.googleapis\.com/],
  ];
  for (const [service, invoke, host] of calls) {
    fakeNetwork();
    await invoke();
    const h = only();
    assert.equal(h.method, "GET", `${service} should make the mapped read`);
    assert.match(new URL(h.url).hostname, host, `${service} should use an allowed Google API host`);
    assert.match(h.headers.authorization ?? "", /^Bearer /, `${service} should use kit-owned authentication`);
    assert.ok(!JSON.stringify(h).includes("kit-placeholder-not-a-key"));
  }
});

test("Google client account pins reject another user in path or query before network", async () => {
  await assert.rejects(sendPrepared("google-workspace", {
    method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/stranger%40example.test/messages", headers: {},
  }), /userId must be the client's own/);
  await assert.rejects(sendPrepared("google-workspace", {
    method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?userId=stranger%40example.test", headers: {},
  }), /userId must be the client's own/);
  assert.equal(hits.length, 0);
});

test("Google Drive writes are blocked before transport and allowed only with the exact SDK body", async () => {
  const file = { name: "Approval document", mimeType: "application/vnd.google-apps.document" };
  const blocked = googleWorkspace("drive").files.create({ requestBody: file });
  await assert.rejects(blocked, /write blocked/);
  assert.equal(hits.length, 0, "blocked writes make no request");

  process.env.KIT_ALLOW_WRITES = "1";
  fakeNetwork({ id: "file-1", ...file });
  const created = await googleWorkspace("drive").files.create({ requestBody: file });
  const h = only();
  assert.equal((created.data as any).id, "file-1");
  assert.equal(h.method, "POST");
  assert.equal(new URL(h.url).hostname, "www.googleapis.com");
  assert.deepEqual(JSON.parse(h.body ?? "null"), file);
  assert.match(h.headers.authorization ?? "", /^Bearer /);
  assert.equal(hits.length, 1, "SDK retries are disabled so one approved write sends once");
});

test("Google SDK HTTP/2 mode fails closed before network", async () => {
  await assert.rejects(
    googleWorkspace("drive").files.list({ pageSize: 1 }, { http2: true } as any),
    /Google SDK HTTP\/2 is not supported by the kit gate/,
  );
  assert.equal(hits.length, 0);
});

test("Google calls never escape the gate", () => { assert.deepEqual(bypass, []); });
