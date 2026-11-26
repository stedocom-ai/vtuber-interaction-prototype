import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,readFile,access} from 'node:fs/promises';
import {startServer,moduleRoot} from '../src/server.ts';
import {DEFAULT_POSE,STALE_MS} from '../web/protocol.js';
let app,config,settingsDirectory;
const clientId='transport-test-client';
before(async()=>{
  await mkdir(path.join(moduleRoot,'verification'),{recursive:true});
  const run=await mkdtemp(path.join(moduleRoot,'verification/http-'));
  settingsDirectory=path.join(run,'isolated-settings');
  app=await startServer({verification:true,settingsDirectory,port:0});
  config=await(await fetch(app.url+'/api/output/controller')).json();
});
after(async()=>{await app?.close();});
const get=uri=>fetch(app.url+uri);
const post=(uri,body,headers={})=>fetch(app.url+uri,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Output-Token':config.token,...headers},body:JSON.stringify(body)});

test('new control page exposes output card module without replacing original camera integration',async()=>{
  const html=await(await get('/')).text();
  assert.match(html,/纯净角色输出技术验证 v0\.1/);assert.match(html,/\/obs\/controller\.js/);assert.match(html,/tracking-app\.js/);
  const script=await(await get('/app.js')).text();assert.match(script,/export const outputModelIdentity/);assert.match(script,/export const previewBridge/);
});
test('pure output page blocks all media permissions and never loads camera or tracking script',async()=>{
  const res=await get('/obs/output'),html=await res.text();assert.equal(res.status,200);
  assert.equal(res.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
  assert.match(res.headers.get('content-security-policy'),/connect-src 'self'/);
  assert.match(html,/<canvas/);assert.match(html,/renderer-support[^>]*hidden|hidden[^>]*renderer-support/);
  assert.doesNotMatch(html,/<video|tracking-app\.js|tracker-worker|face_landmarker/);
  const css=await(await get('/obs/output.css')).text();assert.match(css,/transparent/);assert.doesNotMatch(css,/conic-gradient|checkerboard/);
});
test('read-only output config exposes only gold, not control/settings tokens',async()=>{
  assert.equal(config.modelId,'gold');assert.equal(config.staleMs,STALE_MS);assert.equal(config.outputUrl,app.url+'/obs/output');
  assert.match(config.token,/^[a-f0-9]{48}$/);
  const outputConfig=await(await get('/api/output/config')).json();
  assert.equal(outputConfig.presets.length,1);assert.equal(outputConfig.presets[0].id,'gold');assert.equal(outputConfig.verification,false);
  assert.ok(!('token' in outputConfig));assert.ok(!('settingsToken' in outputConfig));
});
test('output renderer reuses frozen source verbatim apart from the isolated config URL and accepted bridge',async()=>{
  const base=await readFile(path.resolve(moduleRoot,'../vtuber-local-preview/web/app.js'),'utf8');
  const bridge=await readFile(path.resolve(moduleRoot,'../vtuber-camera-tracking/web/preview-bridge.js'),'utf8');
  const actual=await(await get('/obs/renderer.js')).text();
  assert.equal(actual,base.replace("fetch('/api/config', { cache: 'no-store' })","fetch('/api/output/config', { cache: 'no-store' })")+'\n'+bridge);
  assert.equal(await(await get('/obs/contracts.js')).text(),await readFile(path.resolve(moduleRoot,'../vtuber-local-preview/web/contracts.js'),'utf8'));
});
test('writes require correct Origin and dedicated token; public state never reveals them',async()=>{
  assert.equal((await fetch(app.url+'/api/output/start',{method:'POST',body:'{}'})).status,403);
  assert.equal((await post('/api/output/start',{clientId},{'X-Output-Token':'wrong'})).status,403);
  assert.equal((await post('/api/output/start',{clientId},{Origin:'https://outside.invalid'})).status,403);
  const publicState=await(await get('/api/output/state')).json();assert.deepEqual(Object.keys(publicState).sort(),['active','stale','revision','modelId','values'].sort());
});
test('actual HTTP start, six-parameter publish, read and stop preserve exact values',async()=>{
  assert.equal((await post('/api/output/start',{clientId})).status,200);
  try {
    const values={...DEFAULT_POSE,ParamAngleX:12,ParamAngleY:-15,ParamEyeLOpen:0,ParamMouthOpenY:.5};
    const r=await post('/api/output/frame',{clientId,sequence:0,modelId:'gold',values});assert.equal(r.status,200);
    const state=await(await get('/api/output/state')).json();assert.equal(state.active,true);assert.deepEqual(state.values,values);
    assert.equal((await post('/api/output/start',{clientId:'second-controller'})).status,409);
    assert.equal((await post('/api/output/frame',{clientId,sequence:0,modelId:'gold',values})).status,409);
  }finally{assert.equal((await post('/api/output/stop',{clientId})).status,200);}
  const stopped=await(await get('/api/output/state')).json();assert.equal(stopped.active,false);assert.deepEqual(stopped.values,DEFAULT_POSE);
});
test('malformed/oversized JSON, extra image fields and alternate model are blocked',async()=>{
  assert.equal((await post('/api/output/start',{clientId},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('/api/output/start',{clientId,image:'never-log-this-image'})).status,400);
  assert.equal((await post('/api/output/start',{clientId,image:'x'.repeat(5000)})).status,413);
  assert.equal((await fetch(app.url+'/api/output/start',{method:'POST',headers:{Origin:app.url,'X-Output-Token':config.token,'Content-Type':'application/json'},body:'{bad'})).status,400);
  await post('/api/output/start',{clientId});
  try {assert.equal((await post('/api/output/frame',{clientId,sequence:0,modelId:'red',values:DEFAULT_POSE})).status,400);}
  finally{await post('/api/output/stop',{clientId});}
  assert.ok(!JSON.stringify(app.requests).includes('never-log-this-image'));
});
test('read endpoints refuse writes, unknown/traversal files stay closed, cross-origin reads refused',async()=>{
  for(const uri of ['/obs/output','/api/output/state','/api/output/config'])assert.equal((await post(uri,{clientId})).status,405);
  for(const uri of ['/obs/secret','/obs/../src/server.ts','/obs/%2e%2e/src/server.ts','/api/output/unknown'])assert.equal((await get(uri)).status,404);
  assert.equal((await fetch(app.url+'/api/output/state',{headers:{Origin:'https://outside.invalid'}})).status,403);
});
test('stale HTTP reader returns default pose, not last expression or owner data',async()=>{
  const then=Date.now()-STALE_MS-500;
  app.state.start(clientId,then);app.state.publish({clientId,sequence:0,modelId:'gold',values:{...DEFAULT_POSE,ParamEyeLOpen:0}},then);
  const stale=await(await get('/api/output/state')).json();assert.equal(stale.active,false);assert.equal(stale.stale,true);assert.deepEqual(stale.values,DEFAULT_POSE);
});
test('settings reads during isolated validation never create or write real personal preferences',async()=>{
  assert.equal((await get('/api/settings')).status,200);
  await assert.rejects(access(settingsDirectory),{code:'ENOENT'});
});
