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
  await assert.rejects(callOperation('microsoft-advertising','customer-management.SignupCustomer'), /outside the one configured ad account/);
  assert.equal(hits, 2);
 } finally { process.env=before; setTransport(null); }
});

test('Microsoft generator: campaigns and reporting run in the configured account; five customer reads; admin and UET tags refused', async () => {
 const {mapMicrosoftRest} = await import('../tools/sdk-microsoft-rest.mjs');
 const generated = structuredClone(operations);
 mapMicrosoftRest(generated);
 type G = {id: string, api: string, kind: string, server: string, readPost?: boolean, authUnsupported?: string, params: {name: string, required: boolean}[]};
 const enabled = (generated as G[]).filter(op => !op.authUnsupported);
 const uet = (generated as G[]).filter(op => op.id.includes('UetTag'));
 assert.ok(uet.length >= 3);
 for (const op of uet) assert.match(String(op.authUnsupported), /UET tags belong to the manager account/, op.id);
 assert.equal(enabled.filter(op => op.api === 'campaign-management').length, 195 - uet.length);
 for (const name of ['GetFileImportUploadUrl','GetProfileDataFileUrl','GetGeoLocationsFileUrl']) assert.equal(enabled.find(op => op.id === `campaign-management.${name}`)?.kind, 'write', name);
 assert.deepEqual(enabled.filter(op => op.api === 'reporting').map(op => op.id).sort(), ['reporting.PollGenerateReport','reporting.SubmitGenerateReport']);
 assert.deepEqual(enabled.filter(op => op.api === 'customer-management').map(op => op.id.split('.')[1]).sort(),
  ['GetAccount','GetAccountPilotFeatures','GetCurrentUser','GetCustomer','GetCustomerPilotFeatures']);
 for (const name of ['SignupCustomer','AddUser','UpdateUserRoles','AddClientLinks','DeleteAccount','FindAccounts','GetCustomersInfo','GetAccountsInfo','SearchCustomers','SendUserInvitation','UpgradeCustomerToAgency'])
  { const op = (generated as G[]).find(o => o.id === `customer-management.${name}`); if (op) assert.match(String(op.authUnsupported), /outside the one configured ad account/, name); }
 const host = {'campaign-management':'https://campaign.api.bingads.microsoft.com','customer-management':'https://clientcenter.api.bingads.microsoft.com','reporting':'https://reporting.api.bingads.microsoft.com'} as Record<string,string>;
 for (const op of enabled) {
  assert.equal(op.server, host[op.api], op.id);
  const read = (op.id.split('.')[1].startsWith('Get') && !/(AuthKey|UploadUrl|FileUrl)$/.test(op.id)) || op.api === 'reporting';
  assert.equal(op.kind, read ? 'read' : 'write', op.id);
  assert.equal(!!op.readPost, read, op.id);
 }
 const add = enabled.find(op => op.id.endsWith('AddCampaigns'))!;
 assert.deepEqual(add.params.filter(p => p.required).map(p => p.name), ['AccountId','Campaigns']);
});

test('Microsoft report requests and customer reads stay inside the configured account and customer', async () => {
 const before = { ...process.env };
 process.env.MSADS_ACCOUNT_ID = '123'; process.env.MSADS_CUSTOMER_ID = '456';
 process.env.MSADS_ACCESS_TOKEN = 'fake-token'; process.env.MSADS_DEVELOPER_TOKEN = 'fake-developer';
 delete process.env.KIT_ALLOW_WRITES;
 const urls: string[] = [];
 setTransport({fetch:async (url) => { urls.push(String(url)); return new Response('{}',{status:200,headers:{'content-type':'application/json'}}); }, log:()=>{}});
 try {
  const report = (AccountIds: string[]) => ({body:{ReportRequest:{Type:'AccountPerformanceReportRequest', Scope:{AccountIds}}}});
  await callOperation('microsoft-advertising','reporting.SubmitGenerateReport', report(['123']));
  await assert.rejects(callOperation('microsoft-advertising','reporting.SubmitGenerateReport', report(['123','999'])), /must match/);
  await assert.rejects(callOperation('microsoft-advertising','reporting.SubmitGenerateReport', {body:{ReportRequest:{Scope:{AccountIds:['123'], Campaigns:[{AccountId:'999',CampaignId:'1'}]}}}}), /must match/);
  for (const scope of [undefined, {}, {AccountIds: []}]) await assert.rejects(callOperation('microsoft-advertising','reporting.SubmitGenerateReport', {body:{ReportRequest:{Type:'AccountPerformanceReportRequest', Scope: scope}}}), /must (name|match)/);
  // Customer-wide scope reaches every account under the manager account.
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetSharedEntities', {body:{SharedEntityType:'NegativeKeywordList', SharedEntityScope:'Customer'}}), /customer-wide scope is refused/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetBidStrategiesByIds', {body:{BidStrategyIds:['1'], Scope:'Customer'}}), /customer-wide scope is refused/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetLabelAssociationsByEntityIds', {body:{EntityType:'Account', EntityIds:['999']}}), /must match the configured account/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetNegativeKeywordsByEntityIds', {body:{EntityType:'Campaign', EntityIds:['5'], ParentEntityId:'999'}}), /must match the configured account/);
  await callOperation('microsoft-advertising','campaign-management.GetNegativeKeywordsByEntityIds', {body:{EntityType:'Campaign', EntityIds:['5'], ParentEntityId:'123'}});
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetProfileDataFileUrl', {body:{}}), /write blocked/);
  await callOperation('microsoft-advertising','customer-management.GetAccount', {body:{}});
  await assert.rejects(callOperation('microsoft-advertising','customer-management.GetCustomer', {body:{CustomerId:'999'}}), /must match/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.DeleteCampaigns', {body:{CampaignIds:['1']}}), /write blocked/);
  process.env.KIT_ALLOW_WRITES = '1';
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.GetUetTagAuthKey', {body:{}}), /not wired/);
  await assert.rejects(callOperation('microsoft-advertising','campaign-management.DeleteBidStrategies', {body:{BidStrategyIds:['1'], Scope:'Customer'}}), /customer-wide scope is refused/);
  assert.deepEqual(urls.map(u => new URL(u).hostname), ['reporting.api.bingads.microsoft.com','campaign.api.bingads.microsoft.com','clientcenter.api.bingads.microsoft.com']);
 } finally { process.env=before; setTransport(null); }
});

test('Microsoft scope cannot be dodged by splitting the request, odd scope values, nesting or stray spaces', async () => {
 const before = { ...process.env };
 process.env.MSADS_ACCOUNT_ID = '123'; process.env.MSADS_CUSTOMER_ID = '456';
 process.env.MSADS_ACCESS_TOKEN = 'fake-token'; process.env.MSADS_DEVELOPER_TOKEN = 'fake-developer';
 process.env.KIT_ALLOW_WRITES = '1';
 let hits = 0;
 setTransport({fetch:async () => { hits++; return new Response('{}',{status:200,headers:{'content-type':'application/json'}}); }, log:()=>{}});
 try {
  const refused: [string, object][] = [
   ['campaign-management.GetLabelAssociationsByEntityIds', {body:{EntityIds:['999']}, params:{EntityType:'Account'}}],
   ['campaign-management.GetLabelAssociationsByEntityIds', {body:{EntityType:'Account ', EntityIds:['999']}}],
   ['campaign-management.GetLabelAssociationsByEntityIds', {body:{EntityType:['Account'], EntityIds:['999']}}],
   ['campaign-management.GetNegativeKeywordsByEntityIds', {body:{EntityIds:['5'], ParentEntityId:'999'}, params:{EntityType:'Campaign'}}],
   ['campaign-management.GetEditorialReasonsByIds', {body:{AccountId:'123', EntityType:'Account', EntityIdToParentIdAssociations:[{EntityId:'999', ParentId:'1'}]}}],
   ['campaign-management.SetLabelAssociations', {body:{EntityType:'Account', LabelAssociations:[{EntityId:'999', LabelId:'1'}]}}],
   ['campaign-management.GetSharedEntities', {body:{SharedEntityType:'NegativeKeywordList', SharedEntityScope:1}}],
   ['campaign-management.GetSharedEntities', {body:{SharedEntityType:'NegativeKeywordList', SharedEntityScope:['Customer']}}],
   ['campaign-management.GetSharedEntities', {body:{SharedEntityType:'NegativeKeywordList', SharedEntityScope:{Value:'Customer'}}}],
   ['campaign-management.GetSharedEntities', {params:{SharedEntityScope:'Customer'}}],
   ['campaign-management.AddSharedEntity', {body:{SharedEntity:{Name:'x', 'Scope ':'Customer'}}}],
   ['reporting.SubmitGenerateReport', {body:{ReportRequest:{Scope:{AccountIds:['123']}}}, params:{ReportRequest:{Scope:{AccountIds:['999']}}}}],
   ['campaign-management.GetImportEntityIdsMapping', {body:{ImportType:'GoogleImportJob', ImportEntityType:'Account', SourceEntityIds:['999']}}],
   ['campaign-management.GetImportEntityIdsMapping', {body:{ImportType:'GoogleImportJob', ImportEntityType:['Account'], SourceEntityIds:['999']}}],
   ['campaign-management.GetImportEntityIdsMapping', {body:{ImportType:'GoogleImportJob', SourceEntityIds:['999']}, params:{ImportEntityType:' customer'}}],
  ];
  for (const [op, input] of refused) await assert.rejects(callOperation('microsoft-advertising', op, input), /must|refused|scoped/, `${op} ${JSON.stringify(input)}`);
  assert.equal(hits, 0);
  // Mappings of entities below the account (a campaign from the import source) still go through.
  await callOperation('microsoft-advertising', 'campaign-management.GetImportEntityIdsMapping', {body:{ImportType:'GoogleImportJob', ImportEntityType:'Campaign', SourceEntityIds:['5']}});
  assert.equal(hits, 1);
 } finally { process.env=before; setTransport(null); }
});
