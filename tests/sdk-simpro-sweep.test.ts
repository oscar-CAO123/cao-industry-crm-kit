// Every Simpro call through the real call path on a fake network: reads go once, writes and gated reads stop before the
// network, and with writes allowed each request has the right host, method, path, key and body. No real account is reached.
import test from "node:test";
import assert from "node:assert/strict";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { load, callOperation } from "../core/sdk/call.ts";

test("simpro sweep: all 1,494 calls build the right request, and every write stops without approval", async () => {
  type Hit = { url: string; method: string; headers: Record<string, string>; body?: unknown };
  let hits: Hit[] = [];
  const logs: string[] = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      hits.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
    sleep: async () => {},
    log: (l: string) => { logs.push(l); },
  });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SIMPRO_ACCESS_TOKEN: "sp-sweep-token", SIMPRO_BUILD: "acme", SIMPRO_COMPANY_ID: "0" });
  delete process.env.SIMPRO_DOMAIN;
  const hdr = (h: Record<string, string>, n: string) => Object.entries(h).find(([k]) => k.toLowerCase() === n)?.[1];
  const problems: string[] = [];
  let blocked = 0, sent = 0, reads = 0;
  try {
    for (const [id, o] of load("simpro").ops as Map<string, any>) {
      const params: Record<string, unknown> = {};
      for (const x of o.params) if (x.required) params[x.name] = x.in === "path" ? (x.name === "companyID" ? "0" : "7") : (x.type === "integer" ? 1 : "v");
      const input: any = { params, ...(o.body ? { body: { Name: "x" } } : {}) };
      const expectPath = String(o.path).replace("{companyID}", "0").replace(/\{[^}]+\}/g, "7");

      delete process.env.KIT_ALLOW_WRITES;
      hits = [];
      try {
        await callOperation("simpro", id, input);
        if (o.kind === "write") problems.push(`${id}: write sent without approval`);
        else if (hits.length === 1) reads++; else problems.push(`${id}: read made ${hits.length} requests`);
      } catch (e: any) {
        if (o.kind === "write" && e instanceof WriteBlocked && !hits.length) blocked++;
        else problems.push(`${id}: ${String(e?.message ?? e).slice(0, 120)}`);
      }

      process.env.KIT_ALLOW_WRITES = "1";
      hits = [];
      try {
        await callOperation("simpro", id, input);
        const h = hits[0], u = new URL(h.url);
        if (hits.length !== 1) problems.push(`${id}: ${hits.length} requests`);
        if (u.origin !== "https://acme.simprosuite.com") problems.push(`${id}: origin ${u.origin}`);
        if (h.method !== o.method) problems.push(`${id}: method ${h.method}`);
        if (decodeURIComponent(u.pathname) !== expectPath) problems.push(`${id}: path ${u.pathname}`);
        if (hdr(h.headers, "authorization") !== "Bearer sp-sweep-token") problems.push(`${id}: key header`);
        if (o.body && !(String(hdr(h.headers, "content-type")).includes("application/json") && String(h.body).includes('"Name":"x"'))) problems.push(`${id}: body`);
        if (!o.body && h.body) problems.push(`${id}: unexpected body`);
        sent++;
      } catch (e: any) {
        problems.push(`${id}: with writes allowed: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  } finally {
    delete process.env.KIT_ALLOW_WRITES;
    setTransport(null as any);
  }
  assert.deepEqual(problems, []);
  assert.equal(reads, 718);
  assert.equal(blocked, 776, "every write, and the three gated reads, stop before the network");
  assert.equal(sent, 1494);
  assert.equal(logs.some((l) => l.includes("sp-sweep-token")) || hits.some((h) => h.url.includes("sp-sweep-token")), false, "the key never reaches a URL or a log line");
});
