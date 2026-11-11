import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { composioCall, composioEnabled, composioHttpCall } from "../core/sdk/composio.ts";

const spec = { app: "sample", hosts: ["api.example.com"] };
const planned = { method: "GET" as const, url: "https://api.example.com/v1/items?limit=2", headers: {}, kind: "read" as const, readPost: false };
process.env.COMPOSIO_API_KEY = "test-project-key";
process.env.KIT_SAMPLE_COMPOSIO_ACCOUNT_ID = "ca_sample";
process.env.KIT_SAMPLE_COMPOSIO_USER_ID = "user_sample";
after(() => { setTransport(null); delete process.env.COMPOSIO_API_KEY; delete process.env.KIT_SAMPLE_COMPOSIO_ACCOUNT_ID; delete process.env.KIT_SAMPLE_COMPOSIO_USER_ID; delete process.env.KIT_ALLOW_WRITES; delete process.env.KIT_SAMPLE_CONNECTION; });

test("proxy pins account and returns the upstream result", async () => {
  process.env.KIT_SAMPLE_CONNECTION = "composio";
  assert.equal(composioEnabled("sample"), true);
  let called = 0;
  setTransport({ log() {}, fetch: async (url, init) => {
    called++;
    assert.equal(url, "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
    assert.equal((init!.headers as Record<string, string>)["x-api-key"], "test-project-key");
    assert.equal(init!.redirect, "manual");
    const b = JSON.parse(init!.body as string);
    assert.deepEqual(b, { connected_account_id: "ca_sample", user_id: "user_sample", endpoint: planned.url, method: "GET", parameters: [] });
    return Response.json({ status: 200, data: { items: [1] }, headers: { "content-type": "application/json" } });
  } });
  const reply = await composioCall("sample", planned, spec, true);
  assert.equal(called, 1); assert.deepEqual(reply.data, { items: [1] });
});

test("refuses unapproved writes, unsafe targets, credentials and unsupported payloads", async () => {
  let called = 0; setTransport({ log() {}, fetch: async () => { called++; return Response.json({}); } });
  delete process.env.KIT_ALLOW_WRITES;
  await assert.rejects(composioCall("sample", { ...planned, method: "POST", kind: "write" }, spec, false), /write blocked/);
  await assert.rejects(composioCall("sample", { ...planned, url: "https://evil.example/v1" }, spec, true), /host/);
  await assert.rejects(composioCall("sample", { ...planned, url: "https://api.example.com/?api_key=x" }, spec, true), /key in the query/);
  await assert.rejects(composioCall("sample", { ...planned, headers: { Authorization: "Bearer vendor" } }, spec, true), /header/);
  await assert.rejects(composioCall("sample", { ...planned, form: { a: "b" } }, spec, true), /GET cannot carry a body/);
  assert.equal(called, 0);
});

test("upstream error is status-only and write is sent once", async () => {
  process.env.KIT_ALLOW_WRITES = "1"; let called = 0;
  setTransport({ log() {}, fetch: async () => { called++; return Response.json({ status: 503, data: { private: "secret" } }); } });
  await assert.rejects(composioCall("sample", { ...planned, method: "POST", kind: "write", json: { name: "x" } }, spec, false), (e: Error) => e.message.includes("503") && !e.message.includes("secret"));
  assert.equal(called, 1); delete process.env.KIT_ALLOW_WRITES;
});

test("mapped calls use Composio without vendor credentials or fallback", async () => {
  const { callOperation, sendPrepared } = await import("../core/sdk/call.ts");
  process.env.KIT_STRIPE_CONNECTION = "composio";
  process.env.KIT_STRIPE_COMPOSIO_ACCOUNT_ID = "ca_stripe";
  process.env.KIT_STRIPE_COMPOSIO_USER_ID = "user_stripe";
  delete process.env.STRIPE_SECRET_KEY;
  let called = 0;
  setTransport({ log() {}, fetch: async (_url, init) => {
    called++;
    const b = JSON.parse(init!.body as string);
    assert.equal(b.endpoint, "https://api.stripe.com/v1/account");
    assert.deepEqual(b.parameters, []);
    return Response.json({ status: 200, data: { id: "acct_test" } });
  } });
  assert.deepEqual((await callOperation("stripe", "openapi_spec3.GetAccount")).data, { id: "acct_test" });
  assert.ok((await callOperation("stripe", "openapi_spec3.GetAccount", { binary: true })).data instanceof ArrayBuffer);
  const native = await sendPrepared("stripe", { method: "GET", url: "https://api.stripe.com/v1/account", headers: {} });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(native.data)), {id:"acct_test"});
  await assert.rejects(sendPrepared("microsoft-advertising", { method: "GET", url: "https://example.com", headers: {} }), /scope/);
  assert.equal(called, 3);
  delete process.env.KIT_STRIPE_CONNECTION;
  delete process.env.KIT_STRIPE_COMPOSIO_ACCOUNT_ID;
  delete process.env.KIT_STRIPE_COMPOSIO_USER_ID;
});

 test("unknown provider refuses instead of falling back to direct credentials", async () => {
  const { callOperation } = await import("../core/sdk/call.ts");
  process.env.KIT_STRIPE_CONNECTION = "composoi";
  try { await assert.rejects(callOperation("stripe", "openapi_spec3.GetAccount"), /unknown connection provider/); }
  finally { delete process.env.KIT_STRIPE_CONNECTION; }
});


test("form and raw uploads use bounded binary_body without fetching a URL", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  let sent: any;
  setTransport({log() {}, fetch:async (_url,init)=>{sent=JSON.parse(String(init!.body)); return Response.json({status:200,data:{ok:true}});}});
  await composioHttpCall(spec,{method:"POST",url:planned.url,form:[["x","one"],["x","two"]]},false);
  assert.deepEqual(sent.binary_body,{base64:Buffer.from("x=one&x=two").toString("base64"),content_type:"application/x-www-form-urlencoded"});
  await composioHttpCall(spec,{method:"POST",url:planned.url,body:new Uint8Array([1,2,3]),headers:{"Content-Type":"application/octet-stream"}},false);
  assert.equal(sent.binary_body.base64,"AQID");
  await assert.rejects(composioHttpCall(spec,{method:"POST",url:planned.url,body:new Uint8Array(10*1024*1024+1)},false),/10 MiB/);
  delete process.env.KIT_ALLOW_WRITES;
});

test("binary responses require a configured public host and never forward project credentials", async () => {
  let fileUrl="https://files.example.com/result"; let downloads=0;
  setTransport({log(){},fetch:async (url,init)=>{
    if (String(url).startsWith("https://backend.composio.dev/")) return Response.json({status:200,binary_data:{url:fileUrl,size:3,content_type:"application/pdf"}});
    downloads++; assert.equal(new Headers(init!.headers).get("x-api-key"),null); assert.equal(new Headers(init!.headers).get("authorization"),null); assert.equal(init!.redirect,"manual");
    return new Response(new Uint8Array([1,2,3]));
  }});
  delete process.env.COMPOSIO_DOWNLOAD_HOSTS;
  await assert.rejects(composioHttpCall(spec,{url:planned.url,binary:true},true),/COMPOSIO_DOWNLOAD_HOSTS/);
  process.env.COMPOSIO_DOWNLOAD_HOSTS="files.example.com";
  assert.deepEqual(new Uint8Array((await composioHttpCall<ArrayBuffer>(spec,{url:planned.url,binary:true},true)).data),new Uint8Array([1,2,3]));
  fileUrl="http://127.0.0.1/private";
  await assert.rejects(composioHttpCall(spec,{url:planned.url,binary:true},true),/https only/);
  assert.equal(downloads,1);
  delete process.env.COMPOSIO_DOWNLOAD_HOSTS;
});


test("managed bodies cannot override authentication through JSON, forms or encoded SDK payloads", async () => {
 process.env.KIT_ALLOW_WRITES="1"; let hits=0;
 setTransport({log(){},fetch:async()=>{hits++;return Response.json({status:200,data:{}});}});
 for (const fields of [
  {json:{metadata:{access_token:"caller-value"}}},
  {json:{"x-api-key":"caller-value"}},
  {json:{"X-Access-Token":"caller-value"}},
  {json:{"oauth_token":"caller-value"}},
  {json:{"jwt":"caller-value"}},
  {form:[["metadata[api_key]","caller-value"]] as [string,string][]},
  {body:'{"access_token":"caller-value"}',headers:{"content-type":"application/json"}},
  {body:'access%5Ftoken=caller-value',headers:{"content-type":"application/x-www-form-urlencoded"}},
  {body:'--test\r\nContent-Disposition: form-data; name="access_token"\r\n\r\ncaller-value\r\n--test--\r\n',headers:{"content-type":"multipart/form-data; boundary=test"}},
  {body:'--test\r\nContent-Disposition: form-data; name=access_token\r\n\r\ncaller-value\r\n--test--\r\n',headers:{"content-type":"multipart/form-data; boundary=test"}},
 ]) await assert.rejects(composioHttpCall(spec,{method:"POST",url:planned.url,...fields},false),/credentials/);
 assert.equal(hits,0); delete process.env.KIT_ALLOW_WRITES;
});
