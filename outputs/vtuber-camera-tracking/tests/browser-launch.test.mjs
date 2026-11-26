import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {mkdtemp,access} from 'node:fs/promises';
import {edgeCandidates,openTrackingBrowser,requestTrackingPage} from '../src/browser-launch.ts';
import {startServer,moduleRoot} from '../src/server.ts';

const localUrl='http://127.0.0.1:50219';
const env={ProgramW6432:'D:\\Program Files',ProgramFiles:'d:\\program files',
  'ProgramFiles(x86)':'D:\\Program Files (x86)',LOCALAPPDATA:'D:\\User Space\\Local'};
function fixture(options={}) {
  const child=new EventEmitter(),calls=[],checked=[],messages=[];
  child.unrefs=0;child.unref=()=>{child.unrefs++;};
  const dependencies={env,log:message=>messages.push(message),
    access:async file=>{checked.push(file);if(options.missing||options.existing&&file!==options.existing)throw new Error('not available');},
    spawn:(exe,args,spawnOptions)=>{
      calls.push({exe,args,options:spawnOptions});
      if(options.syncError)throw new Error('simulated spawn failure');
      if(!options.wait)queueMicrotask(()=>child.emit(options.error?'error':'spawn',new Error('simulated browser error')));
      return child;
    }};
  return{child,calls,checked,messages,dependencies};
}
test('Edge candidates include both Windows install locations with no environment variables',()=>{
  assert.deepEqual(edgeCandidates({}),['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']);
});
test('Edge candidates deduplicate Windows paths case-insensitively and include per-user install',()=>{
  const files=edgeCandidates(env);
  assert.equal(files.filter(file=>file.toLowerCase().startsWith('d:\\program files\\')).length,1);
  assert.ok(files.includes('D:\\User Space\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.equal(files.length,new Set(files.map(file=>file.toLowerCase())).size);
});
test('all candidate executables are Edge, never Chrome, cmd, PowerShell or a protocol handler',()=>{
  for(const file of edgeCandidates(env))assert.match(file,/\\Microsoft\\Edge\\Application\\msedge\.exe$/);
});
for(const url of [localUrl,localUrl+'/'])test('normal visible Edge window request: '+url,async()=>{
  const f=fixture(),exe=await openTrackingBrowser(url,f.dependencies);
  assert.equal(f.calls.length,1);assert.equal(exe,f.calls[0].exe);
  assert.deepEqual(f.calls[0].args,['--new-window',url]);
  assert.deepEqual(f.calls[0].options,{detached:true,stdio:'ignore',windowsHide:false,shell:false});
  assert.equal(f.child.unrefs,1);
  assert.ok(!f.calls[0].args.some(arg=>/--app|--user-data-dir|--disable-|--headless/.test(arg)));
});
const invalidUrls=[
  'https://127.0.0.1:50219','http://localhost:50219','http://example.com:50219',
  'http://127.1:50219','http://2130706433:50219','http://127.0.0.1',
  'http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:050219',
  'http://user:pass@127.0.0.1:50219','http://127.0.0.1:50219/other',
  'http://127.0.0.1:50219?run=1','http://127.0.0.1:50219#fragment',
  localUrl+'\n',' '+localUrl,'--app='+localUrl,
];
for(const url of invalidUrls)test('reject unsafe browser URL before filesystem/spawn: '+JSON.stringify(url),async()=>{
  const f=fixture();await assert.rejects(openTrackingBrowser(url,f.dependencies),/BROWSER_URL_INVALID/);
  assert.equal(f.checked.length,0);assert.equal(f.calls.length,0);
});
test('per-user Edge is used when earlier candidates are unavailable',async()=>{
  const existing=edgeCandidates(env).at(-1),f=fixture({existing});
  assert.equal(await openTrackingBrowser(localUrl,f.dependencies),existing);
  assert.equal(f.calls.length,1);assert.deepEqual(f.checked,edgeCandidates(env));
});
test('missing Edge never starts Chrome or another command',async()=>{
  const f=fixture({missing:true});await assert.rejects(openTrackingBrowser(localUrl,f.dependencies),/EDGE_UNAVAILABLE/);
  assert.deepEqual(f.checked,edgeCandidates(env));assert.equal(f.calls.length,0);
});
for(const options of [{syncError:true},{error:true}])test('spawn failure is bounded and never retries: '+JSON.stringify(options),async()=>{
  const f=fixture(options);await assert.rejects(openTrackingBrowser(localUrl,f.dependencies),/EDGE_LAUNCH_FAILED/);
  assert.equal(f.calls.length,1);assert.equal(f.child.unrefs,0);
});
test('5-second startup timeout is clear; a late spawn/error cannot retry or unref',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({wait:true}),pending=assert.rejects(openTrackingBrowser(localUrl,f.dependencies),/超过 5 秒/);
  await Promise.resolve();assert.equal(f.calls.length,1);
  t.mock.timers.tick(5001);await pending;
  f.child.emit('spawn');assert.doesNotThrow(()=>f.child.emit('error',new Error('late')));
  assert.equal(f.calls.length,1);assert.equal(f.child.unrefs,0);
});
test('post-spawn error is handled without an unhandled event or another browser',async()=>{
  const f=fixture();await openTrackingBrowser(localUrl,f.dependencies);
  assert.doesNotThrow(()=>f.child.emit('error',new Error('late browser exit')));assert.equal(f.calls.length,1);
});
test('success message waits for spawn and only says requested, not loaded',async()=>{
  const f=fixture({wait:true}),pending=requestTrackingPage(localUrl,f.dependencies);
  await Promise.resolve();assert.equal(f.messages.length,0);assert.equal(f.child.unrefs,0);
  f.child.emit('spawn');assert.equal(await pending,true);
  assert.match(f.messages[0],/已请求.*Edge 普通窗口/);assert.match(f.messages[0],/手动打开/);
  assert.doesNotMatch(f.messages[0],/已成功加载|页面已加载/);
});
test('missing Edge produces readable manual fallback with the exact local address',async()=>{
  const f=fixture({missing:true});assert.equal(await requestTrackingPage(localUrl,f.dependencies),false);
  assert.match(f.messages[0],/本地服务继续运行/);assert.ok(f.messages[0].includes(localUrl));
  assert.match(f.messages[0],/不会自动重试、启动 Chrome 或结束任何浏览器进程/);assert.equal(f.calls.length,0);
});
test('real local server remains available after mocked browser launch failure',async()=>{
  const run=await mkdtemp(path.join(moduleRoot,'verification/edge-launch-'));
  const settingsDirectory=path.join(run,'isolated-settings');
  const app=await startServer({verification:true,settingsDirectory});
  try {
    const f=fixture({error:true});assert.equal(await requestTrackingPage(app.url,f.dependencies),false);
    const response=await fetch(app.url);assert.equal(response.status,200);
    assert.match(await response.text(),/追踪 v0\.1\.5/);
    const settings=await(await fetch(app.url+'/api/settings')).json();assert.equal(settings.settings.reverseY,true);
    await assert.rejects(access(settingsDirectory),{code:'ENOENT'});
    assert.equal(f.calls.length,1);assert.ok(f.messages[0].includes(app.url));
  } finally {await app.close();}
});
