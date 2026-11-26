import path from 'node:path';
import {mkdir,mkdtemp,writeFile,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {moduleRoot,startServer} from '../src/server.ts';
import {workspace,originalRoot,defaultSdk} from '../../vtuber-local-preview/src/server.ts';
import {snapshot} from '../../vtuber-controlled-recolor/src/files.ts';
import {resolveSdk} from '../../vtuber-runtime-recolor/src/core-reader.ts';
import {auditSdkIsolation} from '../../vtuber-runtime-recolor/src/sdk-audit.ts';
const base=path.join(moduleRoot,'verification');await mkdir(base,{recursive:true});
const run=await mkdtemp(path.join(base,new Date().toISOString().replace(/[:.]/g,'-')+'_'));
const save=(name:string,v:unknown)=>writeFile(path.join(run,name),JSON.stringify(v,null,2)+'\n',{flag:'wx'});
console.log('VERIFICATION_DIRECTORY='+run);
const roots=[originalRoot,path.resolve(moduleRoot,'../vtuber-runtime-recolor/runs'),path.resolve(moduleRoot,'../vtuber-runtime-recolor/releases'),path.resolve(moduleRoot,'../vtuber-recolor-gui/releases'),path.resolve(moduleRoot,'../vtuber-local-preview')];
const userData=path.join(moduleRoot,'user-data');
const userSnapshot=async()=>{try{await access(userData);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}return snapshot([userData]);};
const userBefore=await userSnapshot();await save('user-settings-before.json',userBefore);
roots.push(path.join(moduleRoot,'releases/camera-tracking-v0.1'));
roots.push(path.join(moduleRoot,'releases/camera-tracking-v0.1.1'));
roots.push(path.join(moduleRoot,'releases/tracking-settings-v0.1'));
const sdk=await resolveSdk(defaultSdk,workspace),before=await snapshot(roots),sdkBefore=await snapshot([sdk.root]);
await save('protected-before.json',before);await save('sdk-before.json',sdkBefore);
const child=spawn(process.execPath,[...process.execArgv,'--test','--test-reporter=tap','tests/tracking.test.mjs','tests/settings.test.mjs','tests/browser-launch.test.mjs'],{cwd:moduleRoot,windowsHide:true});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
const code=await new Promise(resolve=>child.on('close',resolve));await writeFile(path.join(run,'unit-tests.tap'),log,{flag:'wx'});console.log(log.slice(-500));
if(code!==0)throw new Error('UNIT_FAILURE '+run);
const app=await startServer({verification:true,settingsDirectory:path.join(run,'isolated-settings')});await save('session.json',{run,url:app.url,settingsIsolation:true});console.log('OPEN_BROWSER_URL='+app.url);
let done:any,count=0;const deadline=Date.now()+10*60*1000;
try{
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));for(const e of app.evidence.slice(count))if(e.phase==='check')console.log('BROWSER_CHECK='+JSON.stringify(e.result));count=app.evidence.length;done=app.evidence.find(x=>x.complete);if(done)break;}
  if(!done)throw new Error('BROWSER_TEST_TIMEOUT');await save('browser-tests.json',done);
  const after=await snapshot(roots),sdkAfter=await snapshot([sdk.root]);await save('protected-after.json',after);await save('sdk-after.json',sdkAfter);
  const userAfter=await userSnapshot();await save('user-settings-after.json',userAfter);
  const isolation=await auditSdkIsolation(workspace,moduleRoot,sdk.root,sdkBefore);await save('sdk-isolation.json',isolation);
  const safety=[{name:'原始资产、全部颜色模型、已验收预览器及旧结果完全不变',pass:JSON.stringify(before)===JSON.stringify(after),files:before.length},
    {name:'SDK/Core 291 文件只读且前后校验值相同',pass:JSON.stringify(sdkBefore)===JSON.stringify(sdkAfter),files:sdkBefore.length},
    {name:'无 SDK/Core 副本、链接、Git 跟踪',pass:!isolation.copiedSdkFiles.length&&!isolation.sdkLinks.length},
    {name:'实际 SDK、追踪 JS/WASM/模型资源全部本机成功加载',pass:app.requests.filter(r=>/^\/(sdk|vendor|tracker-model)\//.test(r.path)).every(r=>r.status===200)},
    {name:'测试仅使用隔离配置，真实用户设置完全不变',pass:JSON.stringify(userBefore)===JSON.stringify(userAfter)}];
  const unitPass=Number(/# pass (\d+)/.exec(log)?.[1]??0),browser=done.results??[];
  const pass=!done.error&&browser.length>=23&&done.actualPageReloadTested===true&&browser.every((r:any)=>r.pass)&&safety.every(r=>r.pass);
  const summary={status:pass?'AUTO_PASS_MANUAL_PENDING':'ERROR',run,unitPass,browserPass:browser.filter((r:any)=>r.pass).length,browserTotal:browser.length,safety,realCameraUsed:false,runtime:done.runtime,totalPass:unitPass+browser.filter((r:any)=>r.pass).length+safety.filter(r=>r.pass).length};
  await save('summary.json',summary);await save('requests.json',app.requests);
  const compatibility=(globalThis as any)[Symbol.for('vtuber.verification.realpath')]??[];
  await save('environment-compatibility.json',{execArgv:process.execArgv,realpathFallback:compatibility,junctionFixture:process.env.SETTINGS_JUNCTION_FIXTURE??null});
  await writeFile(path.join(run,'verification.md'),['# Edge 普通窗口启动 v0.1.5 自动验收报告','',`状态：${summary.status}。真实摄像头未开启，等待用户自动打开与关闭重开人工复测。`,`单元/服务 ${unitPass}；浏览器 ${summary.browserPass}/${summary.browserTotal}；安全 ${safety.filter(r=>r.pass).length}/${safety.length}；合计 ${summary.totalPass} 项通过。`,'','| 检查 | 结果 |','|---|---|',...browser.map((r:any)=>`| ${r.name} | ${r.pass?'PASS':r.error} |`),...safety.map(r=>`| ${r.name} | ${r.pass?'PASS':'ERROR'} |`),'','浏览器真实运行官方 MediaPipe WASM，但输入为空白合成画面；模型动作由合成观测驱动。不能据此认证真人精度、左右方向或端到端延迟。','原始前后校验值、SDK 隔离、请求与浏览器详情见本目录 JSON。',done.error??''].join('\n'),{flag:'wx'});
  console.log('RESULT='+JSON.stringify(summary));if(!pass)process.exitCode=1;
}finally{await app.close();}
