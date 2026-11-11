import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const operations = JSON.parse(fs.readFileSync(new URL("../core/sdk/platforms/microsoft-advertising/ops.json", import.meta.url), "utf8"));
const rest = JSON.parse(fs.readFileSync(new URL("../tools/sdk-microsoft-rest.json", import.meta.url), "utf8"));

test("Microsoft REST supplement covers exactly the existing operations", () => {
  assert.deepEqual(Object.keys(rest).sort(), operations.map((op: {id: string}) => op.id).sort());
  for (const op of Object.values(rest) as {method: string, path: string, params: {name: string}[]}[]) {
    assert.match(op.path, /^\/(CampaignManagement|CustomerManagement|Reporting)\/v13\//);
    assert.ok(["POST", "PUT", "DELETE"].includes(op.method));
    assert.equal(new Set(op.params.map(p => p.name)).size, op.params.length);
  }
});

test("Microsoft campaign query uses the published route and request fields", () => {
  const op = rest["campaign-management.GetCampaignsByAccountId"];
  assert.equal(op.method, "POST");
  assert.equal(op.path, "/CampaignManagement/v13/Campaigns/QueryByAccountId");
  assert.deepEqual(op.params.map((p: {name: string}) => p.name), ["AccountId", "CampaignType", "ReturnAdditionalFields"]);
});

import { microsoftInput } from '../core/sdk/microsoft-scope.ts';
import type { Op } from '../core/sdk/call.ts';

const scopedOp = { params: [{name: 'AccountId', in: 'body', required: false, type: 'string'}, {name: 'Campaigns', in: 'body', required: false, type: 'array'}] } as Op;
test('Microsoft scopes both body and params, recursively and before merging', () => {
 const prior = { ...process.env };
 process.env.MSADS_ACCOUNT_ID = '123'; process.env.MSADS_CUSTOMER_ID = '456';
 try {
  assert.deepEqual(microsoftInput(scopedOp, {body: {Campaigns: [{AccountIds: ['123'], CustomerId: '456'}]}}).params, {AccountId: '123'});
  const invalid = [
   {AccountId: '999'}, {AccountIds: []}, {AccountIds: null}, {AccountIds: ['123', '999']},
   {CustomerIds: []}, {CustomerIds: null}, {CustomerId: '999'}, {NewAccountIds: ['999']},
   {ParentCustomerId: '999'}, {Account: {Id: '999'}}, {Customer: {Id: '999'}},
  ];
  for (const nested of invalid) assert.throws(() => microsoftInput(scopedOp, {body: {Campaigns: [nested]}}), /must match|not scoped/);
  assert.throws(() => microsoftInput(scopedOp, {body: {AccountId: '999'}, params: {AccountId: '123'}}), /must match/);
  assert.throws(() => microsoftInput(scopedOp, {body: {AccountId: '123', Other: 1}}), /unknown body/);
  assert.throws(() => microsoftInput(scopedOp, {body: []}), /must be an object/);
  delete process.env.MSADS_ACCOUNT_ID;
  assert.throws(() => microsoftInput(scopedOp, {}), /configure numeric/);
 } finally { process.env = prior; }
});

import { load, plan, callOperation, sendPrepared } from '../core/sdk/call.ts';
import { setTransport } from '../core/lib/http.ts';
test('Microsoft REST serializes scoped requests and gates writes before the socket', async () => {
 const before = { ...process.env };
 const {ops} = load('microsoft-advertising');
 const read = ops.get('campaign-management.GetCampaignsByAccountId')!;
 const write = ops.get('campaign-management.AddCampaigns')!;
 let hits = 0, observed: RequestInit | undefined;
 process.env.MSADS_ACCOUNT_ID = '123'; process.env.MSADS_CUSTOMER_ID = '456';
 process.env.MSADS_ACCESS_TOKEN = 'fake-token'; process.env.MSADS_DEVELOPER_TOKEN = 'fake-developer';
 delete process.env.KIT_ALLOW_WRITES;
 setTransport({fetch:async (_url, init) => { hits++; observed = init; return new Response('{}',{status:200,headers:{'content-type':'application/json'}}); }, log:()=>{}});
 try {
  const result = await plan('microsoft-advertising', read.id, {body:{CampaignType:'Search'}}, true);
  assert.equal(result.url, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId');
  assert.deepEqual(result.json, {CampaignType:'Search',AccountId:'123'});
  assert.equal(result.headers.Authorization, 'Bearer fake-token');
  assert.equal(result.headers.CustomerId, '456');
  assert.equal(result.headers.CustomerAccountId, '123');
  assert.equal(result.headers.DeveloperToken, 'fake-developer');
  await callOperation('microsoft-advertising', read.id, {body:{CampaignType:'Search'}});
  assert.equal(hits, 1); assert.deepEqual(JSON.parse(String(observed!.body)), {CampaignType:'Search',AccountId:'123'});
  await assert.rejects(callOperation('microsoft-advertising', read.id, {body:{AccountId:'999'}}), /must match/);
  await assert.rejects(callOperation('microsoft-advertising', write.id, {body:{Campaigns:[]}}), /write blocked/);
  process.env.KIT_ALLOW_WRITES='1';
  await assert.rejects(callOperation('microsoft-advertising', write.id, {body:{}}), /missing required Campaigns/);
  await assert.rejects(callOperation('microsoft-advertising', write.id, {body:{Campaigns:null}}), /missing required Campaigns/);
  await assert.rejects(callOperation('microsoft-advertising', write.id, {body:{Campaigns:[{AccountIds:[]}]}}), /must match/);
  await callOperation('microsoft-advertising', write.id, {body:{Campaigns:[{Name:'Example'}]}});
  assert.equal(hits, 2); assert.deepEqual(JSON.parse(String(observed!.body)), {Campaigns:[{Name:'Example'}], AccountId:'123'});
  delete process.env.MSADS_DEVELOPER_TOKEN;
  await assert.rejects(callOperation('microsoft-advertising', write.id, {body:{Campaigns:[]}}), /MSADS_DEVELOPER_TOKEN/);
  await assert.rejects(sendPrepared('microsoft-advertising',{method:'POST',url:'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId',headers:{},body:'{}'}), /not routed/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.DeleteCampaigns'), /not wired/);
  assert.equal(hits, 2);
 } finally { process.env=before; setTransport(null); }
});

test('Microsoft generator only enables the reviewed pair', async () => {
 const {mapMicrosoftRest} = await import('../tools/sdk-microsoft-rest.mjs');
 const generated = structuredClone(operations);
 mapMicrosoftRest(generated);
 const enabled = generated.filter((op: {authUnsupported?: string}) => !op.authUnsupported);
 assert.deepEqual(enabled.map((op: {id: string}) => op.id).sort(), ['campaign-management.AddCampaigns','campaign-management.GetCampaignsByAccountId']);
 const add = enabled.find((op: {id: string}) => op.id.endsWith('AddCampaigns'));
 assert.deepEqual(add.params.filter((p: {required: boolean}) => p.required).map((p: {name: string}) => p.name), ['AccountId','Campaigns']);
});
