import test from 'node:test';
import assert from 'node:assert/strict';
import {load, plan, sendPrepared, callOperation} from '../core/sdk/call.ts';
import {setTransport} from '../core/lib/http.ts';
process.env.MANDRILL_API_KEY='fake-mandrill'; process.env.DROPBOX_ACCESS_TOKEN='fake-dropbox';

test('Mandrill uses secret-store key in body and rejects caller overrides', async () => {
 const op='2.allowlist_allowlists/list';
 const preview=await plan('mailchimp',op,{body:{}});
 assert.deepEqual(preview.json,{key:'[from MANDRILL_API_KEY]'});
 assert.deepEqual((await plan('mailchimp',op,{body:{}},true)).json,{key:'fake-mandrill'});
 await assert.rejects(plan('mailchimp',op,{body:{key:'other'}},true),/secret store/);
 await assert.rejects(sendPrepared('mailchimp',{method:'POST',url:'https://mandrillapp.com/api/1.4/allowlists/list',headers:{},body:'{}'}),/body-key/);
});

test('Dropbox content routes carry arguments in header and gate uploads', async () => {
 const dl=await plan('dropbox','files.download',{params:{path:'/résumé'}},true);
 assert.equal(dl.url,'https://content.dropboxapi.com/2/files/download');
 assert.equal(JSON.parse(dl.headers['Dropbox-API-Arg']).path,'/résumé');
 const ul=await plan('dropbox','files.upload',{params:{path:'/file'},contentBase64:'aGk='},true);
 assert.equal(Buffer.from(ul.body!).toString(),'hi');
 await assert.rejects(plan('dropbox','files.upload',{params:{path:'/file'},contentBase64:'!!!!'},true),/valid base64/);
 delete process.env.KIT_ALLOW_WRITES;
 await assert.rejects(callOperation('dropbox','files.upload',{params:{path:'/file'},contentBase64:'aGk='}),/write blocked/);
});

test('Dropbox download returns raw bytes and metadata through HTTP transport', async () => {
 let observed: RequestInit | undefined;
 setTransport({fetch:async (_url, init) => {
  observed=init;
  return new Response(Uint8Array.from([0,255,42]),{status:200,headers:{"content-type":"application/octet-stream","dropbox-api-result":"{\"name\":\"file.bin\"}"}});
 },log:()=>{}});
 process.env.KIT_ALLOW_WRITES='1';
 try {
  const result=await callOperation<ArrayBuffer>('dropbox','files.download',{params:{path:'/file.bin'}});
  assert.deepEqual([...new Uint8Array(result.data)],[0,255,42]);
  assert.equal(result.headers.get('dropbox-api-result'),'{"name":"file.bin"}');
  assert.equal(new Headers(observed!.headers).get('dropbox-api-arg'),'{"path":"/file.bin"}');
 } finally { delete process.env.KIT_ALLOW_WRITES; setTransport(null); }
});

test('vendor reserved resource names validate pattern, traversal and account pins', async () => {
 const {platform:p}=load('google-analytics'); const prior=p.auth; const oldPin=p.pinned;
 p.auth={type:'bearer',env:'FAKE_GA_TOKEN'};p.pinned={name:{allow:['properties/123/metadata'],env:'FAKE_GA_ALLOWED'}};
 process.env.FAKE_GA_TOKEN='fake'; let hits=0;
 setTransport({fetch:async()=>{hits++;return new Response('{}',{status:200})},log:()=>{}});
 const req=(path:string)=>({method:'GET',url:'https://analyticsdata.googleapis.com/v1beta/'+path,headers:{}});
 try {
  await sendPrepared('google-analytics',req('properties/123/metadata')); assert.equal(hits,1);
  await assert.rejects(sendPrepared('google-analytics',req('properties/999/metadata')),/client.s own/);
  await assert.rejects(sendPrepared('google-analytics',req('properties/123/other')),/pattern|mapped endpoint/);
  await assert.rejects(sendPrepared('google-analytics',req('properties/123%2Fother/metadata')),/not allowed/);
  await assert.rejects(sendPrepared('google-analytics',req('properties/123/%2e%2e/metadata')),/mapped endpoint|not allowed|pattern/);
  assert.equal(hits,1);
 } finally { p.auth=prior;p.pinned=oldPin;setTransport(null); }
});
