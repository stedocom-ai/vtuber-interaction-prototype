import {WorkerTracker} from './worker-client.js';
import {DEFAULTS,observation,TrackerMapping} from './mapping.js';
import {CameraSession} from './session.js';
import {SETTINGS_DEFAULTS} from './settings-schema.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function run({bridge,session,config,trackingOptions,settingsClient}){
  const results=[];let tracker;
  const check=async(name,fn)=>{try{const detail=await fn();results.push({name,pass:true,detail});}catch(e){results.push({name,pass:false,error:String(e?.message??e)});}await send({phase:'check',result:results.at(-1)});};
  const assert=(v,m)=>{if(!v)throw new Error(m);};
  const send=value=>fetch('/api/evidence',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':config.token},body:JSON.stringify(value)});
  const until=performance.now()+30000;while(!bridge.ready()&&performance.now()<until)await pause(100);
  const resumeKey='settings-verification-resume';
  const settle=async()=>{const deadline=performance.now()+12000;while(settingsClient.busy&&performance.now()<deadline)await pause(20);assert(!settingsClient.busy,'settings request timeout');};
  const persisted=async()=>{const r=await fetch('/api/settings');assert(r.ok,'settings GET failed');return r.json();};
  const editThreshold=v=>{const input=document.getElementById('eye-threshold');input.value=String(v);input.dispatchEvent(new Event('input'));};
  const resume=sessionStorage.getItem(resumeKey);
  if(resume){
    sessionStorage.removeItem(resumeKey);const previous=JSON.parse(resume);results.push(...previous.results);
    await check('真正刷新页面后恢复 0.40 和方向选项，摄像头仍关闭',()=>{
      assert(bridge.ready()&&settingsClient.ready,'not ready after reload');const o=trackingOptions();assert(o.eyeCloseThreshold===.4&&!o.reverseX&&o.reverseY&&o.reverseZ&&o.swapEyes,'preferences lost after reload');assert(['reverse-x','reverse-y','reverse-z','swap-eyes'].every(id=>!document.getElementById(id).disabled),'direction controls still disabled');assert(session.state==='idle'&&!session.stream&&document.getElementById('camera-video').srcObject===null,'camera auto-started');
    });
    await check('未点击保存的修改只在内存，不改变磁盘',async()=>{editThreshold(.5);assert(document.getElementById('settings-status').textContent.includes('尚未保存'),'no dirty hint');assert((await persisted()).settings.eyeCloseThreshold===.4,'implicit save');});
    await check('重新读取按钮恢复磁盘设置，未自动开启摄像头',async()=>{document.getElementById('reverse-z').closest('label').click();document.getElementById('settings-reload').click();await settle();assert(trackingOptions().eyeCloseThreshold===.4&&trackingOptions().reverseZ&&!document.getElementById('reverse-z').disabled&&session.state==='idle','reload mismatch');});
    await check('恢复默认并保存按钮同时恢复阈值和方向，磁盘内容正确',async()=>{document.getElementById('settings-reset').click();await settle();const o=trackingOptions();assert(JSON.stringify((await persisted()).settings)===JSON.stringify(SETTINGS_DEFAULTS),'reset not saved');assert(o.eyeCloseThreshold===.3&&o.reverseX&&o.reverseY&&!o.reverseZ&&!o.swapEyes,'reset not applied');assert(session.state==='idle','reset opened camera');});
    await check('默认值重新读取仍有效、设置路径可见、无相机状态持久化',async()=>{await settingsClient.load();assert(trackingOptions().eyeCloseThreshold===.3,'default not restored');assert(document.getElementById('settings-path').textContent.endsWith('tracking-settings.json'),'no settings path');const saved=(await persisted()).settings;assert(Object.keys(saved).length===6&&!('autoStartCamera' in saved),'unexpected persisted field');});
    document.getElementById('camera-status').textContent='设置保存与页面刷新验证完成；真实摄像头从未开启。';
    await send({complete:true,results,runtime:previous.runtime,userAgent:navigator.userAgent,realCameraUsed:false,actualPageReloadTested:true});return;
  }
  await check('官方 Live2D 渲染器加载且六参数存在',()=>assert(bridge.ready()&&Object.keys(bridge.values()).length===6,'not ready'));
  await check('页面启动不请求摄像头，默认空流',()=>assert(session.state==='idle'&&!session.stream&&document.getElementById('camera-video').srcObject===null,'camera unexpectedly active'));
  await check('四个方向/眼睛开关不展开折叠区也可见、可用，ID 唯一',()=>{
    assert(document.querySelector('.tracking details').open===false,'optional video unexpectedly expanded');
    for(const id of ['reverse-x','reverse-y','reverse-z','swap-eyes']){
      const input=document.getElementById(id),label=input.closest('label'),rect=label.getBoundingClientRect();
      assert(document.querySelectorAll('#'+id).length===1&&!input.closest('details')&&input.closest('#direction-options'),'direction control hidden or duplicated: '+id);
      assert(!input.disabled&&rect.width>0&&rect.height>0&&getComputedStyle(label).visibility==='visible','direction control not visible/available: '+id);
    }
  });
  await check('点击四项文字独立反转 X/Y/Z 或交换眼睛，贯通界面到 Core，其他参数不变',()=>{
    const drive=()=>{const m=new TrackerMapping();for(let t=0;t<=800;t+=16){m.accept({x:12,y:9,z:7,left:.35,right:0,jaw:.2},t,trackingOptions());bridge.apply(m.tick(t).values);}return bridge.values();};
    const base=drive(),pairs=[['reverse-x','ParamAngleX'],['reverse-y','ParamAngleY'],['reverse-z','ParamAngleZ'],['swap-eyes',null]];
    try{for(const [id,axis] of pairs){
      const input=document.getElementById(id),original=input.checked;
      try{input.closest('label').click();assert(input.checked!==original&&document.getElementById('settings-status').textContent.includes('尚未保存'),'label/change disconnected: '+id);const actual=drive();
        for(const key of Object.keys(base)){const expected=key===axis?-base[key]:id==='swap-eyes'&&key==='ParamEyeLOpen'?base.ParamEyeROpen:id==='swap-eyes'&&key==='ParamEyeROpen'?base.ParamEyeLOpen:base[key];assert(Math.abs(actual[key]-expected)<.00001,'independent mapping failed: '+id+'/'+key);}
      }finally{if(input.checked!==original)input.closest('label').click();}
    }}finally{bridge.reset();}
    assert(session.state==='idle'&&!session.stream,'camera unexpectedly opened');
  });
  await check('可选镜像画面开关仅改变 video 显示，不改变追踪方向、不请求摄像头',()=>{
    const input=document.getElementById('show-camera'),before=JSON.stringify(trackingOptions());
    try{input.closest('label').click();assert(!document.getElementById('camera-video').hidden&&JSON.stringify(trackingOptions())===before,'video toggle changed direction');}
    finally{if(input.checked)input.closest('label').click();}
    assert(document.getElementById('camera-video').hidden&&session.state==='idle'&&!session.stream,'video toggle opened camera');
  });
  await check('v0.1.4 界面默认反转 X/Y；闭眼阈值控件实际传入参数映射',()=>{
    assert(document.getElementById('reverse-x').checked&&trackingOptions().reverseX&&document.getElementById('reverse-y').checked&&trackingOptions().reverseY,'X/Y reversal not default');
    const input=document.getElementById('eye-threshold');assert(trackingOptions().eyeCloseThreshold===.30,'threshold default');
    try{input.value='.5';input.dispatchEvent(new Event('input'));assert(trackingOptions().eyeCloseThreshold===.5&&document.getElementById('eye-threshold-value').textContent==='0.50','UI options disconnected');}
    finally{input.value='.30';input.dispatchEvent(new Event('input'));}
  });
  await check('v0.1.1 中等闭眼信号通过界面配置到 Core 参数零端点；头部默认镜像',()=>{
    const m=new TrackerMapping();
    for(let t=0;t<=240;t+=16){m.accept({x:12,y:0,z:0,left:.34,right:0,jaw:0},t,trackingOptions());bridge.apply(m.tick(t).values);}
    const values=bridge.values();assert(values.ParamAngleX<0&&values.ParamEyeLOpen===0&&values.ParamEyeROpen===1,'wrong mapped endpoints');bridge.pixels();bridge.reset();
  });
  await check('本地 Worker / WASM / 官方模型实际初始化',async()=>{tracker=new WorkerTracker();await tracker.ready;});
  const blank=document.createElement('canvas');blank.width=640;blank.height=480;const ctx=blank.getContext('2d');ctx.fillStyle='#808080';ctx.fillRect(0,0,640,480);
  await check('真实推理处理空白合成帧，正确返回无人脸',async()=>{const r=await tracker.frame(await createImageBitmap(blank),performance.now());assert(observation(r.result)===null,'false face');return{latencyMs:r.latency,width:640,height:480};});
  await check('六参数合成观测实际驱动模型，像素画面变化',()=>{
    bridge.reset();const before=bridge.pixels();const m=new TrackerMapping();const o={x:25,y:-20,z:15,left:1,right:0,jaw:.7};
    for(let t=0;t<=1000;t+=16){m.accept(o,t);bridge.apply(m.tick(t).values);}
    const after=bridge.pixels(),v=bridge.values();assert(v.ParamEyeLOpen<.01&&v.ParamEyeROpen===1&&v.ParamMouthOpenY>.99,'mapping');let n=0;for(let i=0;i<before.length;i++)if(before[i]!==after[i])n++;assert(n>100,'no rendered change');bridge.reset();return{changedChannels:n};
  });
  await check('真实浏览器合成视频流停止后所有轨道 ended',async()=>{
    const stream=blank.captureStream(10),video=document.createElement('video');video.muted=true;
    const drawTimer=setInterval(()=>ctx.fillRect(0,0,640,480),50);
    const s=new CameraSession({acquire:async()=>stream,createTracker:()=>({ready:Promise.resolve(),close(){}}),attach:async s=>{video.srcObject=s;await video.play();},detach:()=>{video.pause();video.srcObject=null;},onState(){}});
    try{await s.start();assert(s.state==='running','not running');s.stop();assert(stream.getTracks().every(t=>t.readyState==='ended')&&video.srcObject===null,'not released');}finally{s.stop();clearInterval(drawTimer);}
  });
  await check('失去人脸回正且手动默认值可恢复',()=>{const m=new TrackerMapping();m.accept({x:25,y:10,z:-10,left:1,right:1,jaw:1},0);m.tick(0);for(let t=16;t<3000;t+=16)m.tick(t);bridge.apply(m.values);assert(Math.abs(bridge.values().ParamAngleX)<.001,'not neutral');bridge.reset();assert(JSON.stringify(bridge.values())===JSON.stringify(DEFAULTS),'defaults');});
  await check('界面拒绝权限显示中文提示且没有视频流（注入拒绝结果）',async()=>{
    const acquire=session.acquire;
    try{session.acquire=async()=>{throw Object.assign(new Error('synthetic denial'),{name:'NotAllowedError'});};document.getElementById('camera-start').click();await pause(50);assert(session.state==='idle'&&!session.stream,'not idle');assert(document.getElementById('camera-status').textContent.includes('权限未获允许'),'missing Chinese error');}
    finally{session.acquire=acquire;session.stop();}
  });
  await check('界面开启/停止贯通实际 Worker 与视频，手动控制恢复（合成视频流）',async()=>{
    const acquire=session.acquire,stream=blank.captureStream(15),drawTimer=setInterval(()=>ctx.fillRect(0,0,640,480),50);
    try{
      session.acquire=async()=>stream;document.getElementById('camera-start').click();
      const deadline=performance.now()+35000;while(session.state==='starting'&&performance.now()<deadline)await pause(50);
      assert(session.state==='running','synthetic UI start: '+document.getElementById('camera-status').textContent);
      assert(document.getElementById('ParamAngleX').disabled,'manual not disabled');await pause(1500);
      assert(session.state==='running'&&document.getElementById('track-stats').textContent.includes('次/秒'),'no actual UI inference');
      document.getElementById('camera-stop').click();
      assert(session.state==='idle'&&stream.getTracks().every(t=>t.readyState==='ended'),'stream still live');
      assert(!document.getElementById('ParamAngleX').disabled&&document.getElementById('camera-video').srcObject===null,'manual not restored');
    }finally{session.stop();session.acquire=acquire;clearInterval(drawTimer);stream.getTracks().forEach(t=>t.stop());}
  });
  await send({phase:'functional',results});
  let runtime=null;
  if(results.every(r=>r.pass))await check('60 秒实际本地推理与 Live2D 并行稳定（合成空白，不代表真人性能）',async()=>{
    const start=performance.now(),startFrames=bridge.metrics.frames,resources=bridge.resources();let n=0,maxLatency=0;const latencies=[];
    while(performance.now()-start<60000){assert(!document.hidden,'verification window hidden');const r=await tracker.frame(await createImageBitmap(blank),performance.now());assert(observation(r.result)===null,'unexpected face');n++;maxLatency=Math.max(maxLatency,r.latency);latencies.push(r.latency);await pause(40);}
    runtime={elapsedMs:performance.now()-start,inferenceFrames:n,renderFrames:bridge.metrics.frames-startFrames,maxInferenceMs:maxLatency,meanInferenceMs:latencies.reduce((a,b)=>a+b,0)/n,resourcesBefore:resources,resourcesAfter:bridge.resources(),errors:[...bridge.metrics.errors],contextLosses:bridge.metrics.contextLosses};
    assert(runtime.renderFrames>1000,'render stalled');assert(runtime.errors.length===0&&runtime.contextLosses===0,'graphics errors');assert(JSON.stringify(resources)===JSON.stringify(bridge.resources()),'GL resource growth');return runtime;
  });
  tracker?.close();bridge.reset();
  await check('验证后真实摄像头仍关闭',()=>assert(session.state==='idle'&&document.getElementById('camera-video').srcObject===null,'camera active'));
  await check('首次设置加载为默认值，不自动保存、不自动开启摄像头',async()=>{assert(settingsClient.ready&&trackingOptions().eyeCloseThreshold===.3,'default load');assert((await persisted()).source==='defaults','unexpected disk write');assert(session.state==='idle','camera active');});
  await check('保存按钮将 0.40 与方向选项写入隔离测试配置',async()=>{
    editThreshold(.4);for(const [id,value] of [['reverse-x',false],['reverse-y',true],['reverse-z',true],['swap-eyes',true]]){const input=document.getElementById(id);if(input.checked!==value)input.closest('label').click();}
    document.getElementById('settings-save').click();await settle();const data=await persisted();assert(data.settings.eyeCloseThreshold===.4&&!data.settings.reverseX&&data.settings.reverseY&&data.settings.reverseZ&&data.settings.swapEyes,'save mismatch');assert(['reverse-x','reverse-y','reverse-z','swap-eyes'].every(id=>!document.getElementById(id).disabled),'save left direction controls disabled');assert(document.getElementById('settings-status').textContent.includes('已保存'),'missing success');
  });
  if(results.every(r=>r.pass)){
    sessionStorage.setItem(resumeKey,JSON.stringify({results,runtime}));await send({phase:'reload',results});location.reload();return;
  }
  document.getElementById('camera-status').textContent='自动验证结束；摄像头未开启。请由你进行真实人脸人工验收。';
  await send({complete:true,results,runtime,userAgent:navigator.userAgent,realCameraUsed:false});
}
