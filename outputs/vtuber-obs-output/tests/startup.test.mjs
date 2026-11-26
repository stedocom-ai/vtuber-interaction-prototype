import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {startServer,OUTPUT_PORT,moduleRoot,outputStartupMessage} from '../src/server.ts';
const compat=new URL('../../vtuber-camera-tracking/scripts/windows-realpath-compat.mjs',import.meta.url).href;
async function childRun(executable,args,{input='',env={}}={}){
  const child=spawn(executable,args,{cwd:moduleRoot,env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',text=>stdout+=text);child.stderr.on('data',text=>stderr+=text);
  child.stdin.on('error',()=>{});child.stdin.end(input);
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},15000);
  try{const [code,signal]=await once(child,'close');assert.equal(timedOut,false,'本次测试子进程应自行非零退出');return {code,signal,stdout,stderr};}
  finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
const childCli=(args=[])=>childRun(process.execPath,['--import',compat,'src/server.ts',...args]);
const conflictText=result=>{
  assert.notEqual(result.code,0);assert.equal(result.signal,null);
  assert.match(result.stderr,/固定端口 43127 已被占用/);assert.match(result.stderr,/不会改用其他端口、结束其他进程或打开占用者网页/);
  assert.doesNotMatch(result.stdout,/控制页：|OBS 浏览器源：|已请求 Microsoft Edge|自动打开浏览器/);
};

test('startup diagnostics explain address-in-use and denied access without advertising a fallback',()=>{
 assert.match(outputStartupMessage({code:'EADDRINUSE'}),/固定端口 43127 已被占用/);
 for(const code of ['EACCES','EPERM'])assert.match(outputStartupMessage({code}),/无法监听本机固定端口 43127/);
 assert.equal(outputStartupMessage(new Error('specific reason')),'specific reason');
});

test('actual CLI --open rejects an unrelated occupier without visiting it or ending it',async()=>{
 // An already configured OBS reader may keep polling /obs/* or /api/output/*.
 // The automatic opener targets only the control-page root, so measure that route.
 let visits=0;const server=http.createServer((req,res)=>{if(req.url==='/')visits++;res.end('unrelated occupier');});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(OUTPUT_PORT,'127.0.0.1',resolve);});
 try{
   const result=await childCli(['--open']);conflictText(result);assert.equal(visits,0);
   assert.equal(server.listening,true);assert.equal(await(await fetch('http://127.0.0.1:'+OUTPUT_PORT)).text(),'unrelated occupier');
 }finally{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('actual CLI duplicate exits nonzero and leaves the first output service untouched',async()=>{
 const app=await startServer({settingsDirectory:path.join(moduleRoot,'verification','startup-isolated-settings')});
 try{
  const controller=await(await fetch(app.url+'/api/output/controller')).json();
  const result=await childCli(['--open']);conflictText(result);
  const after=await(await fetch(app.url+'/api/output/controller')).json();
  assert.equal(after.token,controller.token);assert.equal(app.server.listening,true);
  assert.equal((await(await fetch(app.url+'/api/output/state')).json()).active,false);
 }finally{await app.close();}
});

test('Windows launcher preserves the nonzero Node result after its existing pause',async()=>{
 assert.equal(process.platform,'win32','此阶段实际 Windows CMD 启动器检查');
 const blocker=http.createServer((req,res)=>res.end('launcher blocker'));
 await new Promise((resolve,reject)=>{blocker.once('error',reject);blocker.listen(OUTPUT_PORT,'127.0.0.1',resolve);});
 try{
  const result=await childRun(process.env.ComSpec??'C:/Windows/System32/cmd.exe',['/d','/c','start-output.cmd'],{input:'\r\n',env:{NODE_OPTIONS:'--import='+compat,LANG:'en_US.UTF-8'}});
  assert.notEqual(result.code,0);assert.equal(result.signal,null);
  assert.doesNotMatch(result.stdout,/控制页：|OBS 浏览器源：|已请求 Microsoft Edge/);
  assert.ok(result.stderr.length>0,'Node输出了启动错误');assert.equal(blocker.listening,true);
 }finally{blocker.closeAllConnections();await new Promise((resolve,reject)=>blocker.close(e=>e?reject(e):resolve()));}
});

