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

test("BigQuery exposes only the pinned project's gated dataset listing", async () => {
  const { bigquery } = await import("../core/sdk/vendor/bigquery.ts");
  process.env.GOOGLE_CLOUD_PROJECT="test-project";
  const api = bigquery();
  assert.equal((api as any).createQueryStream, undefined);
  assert.equal((api as any).createQueryJob, undefined);
  await api.listDatasets();
  assert.equal(hits.length,1);
  assert.match(only().url, /bigquery\.googleapis\.com\/bigquery\/v2\/projects\/test-project\/datasets/);
  assert.match(only().headers.authorization ?? "", /^Bearer /);
  assert.deepEqual(bypass,[]);
});
