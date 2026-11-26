import {previewBridge as bridge} from './app.js';
import {TrackerMapping,observation,TRACKING_DEFAULTS} from './mapping.js';
import {CameraSession,cameraError} from './session.js';
import {WorkerTracker} from './worker-client.js';
import {SettingsClient} from './settings-client.js';
import {SETTINGS_DEFAULTS} from './settings-schema.js';
const panel=document.createElement('section');panel.className='card tracking';
panel.innerHTML=`<h2>摄像头追踪 v0.1.5 <span class="local-tag">设置保存 v0.1</span></h2>
<p class="hint">默认关闭。点击开启后才请求权限；不录制、不上传、不使用麦克风。请保持单人入镜。</p>
<div class="track-actions"><button id="camera-start" disabled>开启摄像头追踪</button><button id="camera-stop" class="secondary" disabled>停止</button></div>
<p id="camera-status" role="status" aria-live="polite">摄像头关闭，正在等待角色加载。</p>
<fieldset id="direction-options" class="direction-options"><legend>转头方向与左右眼</legend>
<div class="options"><label><input type="checkbox" id="reverse-x">反转左右转头</label><label><input type="checkbox" id="reverse-y">反转抬头低头</label><label><input type="checkbox" id="reverse-z">反转左右歪头</label><label><input type="checkbox" id="swap-eyes">交换左右眼</label></div>
<p class="hint">方向不符合预期时，勾选或取消对应开关；调整后点击下方“保存设置”。下次启动恢复你最后一次成功保存的勾选，不会自动重置为默认方向。</p></fieldset>
<div class="track-actions"><button id="calibrate" class="secondary" disabled>正视校准</button><button id="clear-calibration" class="secondary">清除校准</button></div>
<p id="calibration-status" class="hint">未校准</p><p id="track-stats" class="hint">追踪尚未启动</p>
<div class="eye-tuning"><label for="eye-threshold">闭眼阈值 <output id="eye-threshold-value">${TRACKING_DEFAULTS.eyeCloseThreshold.toFixed(2)}</output></label>
<input id="eye-threshold" type="range" min="0.15" max="0.80" step="0.01" value="${TRACKING_DEFAULTS.eyeCloseThreshold}">
<p class="hint">闭眼仍不到 0 → 向左调小；正常睁眼却容易合上 → 向右调大。左右眼独立驱动，共用此阈值。</p>
<p id="eye-signals" class="hint">闭眼信号：等待追踪（不是眼睛开合参数）</p></div>
<details><summary>本地摄像头画面（可选）</summary><p class="hint">镜像摄像头画面只影响画面显示，不改变转头方向或模型参数。</p>
<div class="options"><label><input type="checkbox" id="show-camera">显示镜像摄像头画面</label></div>
<video id="camera-video" autoplay muted playsinline hidden></video></details>
<div class="saved-settings"><div class="track-actions"><button id="settings-save" disabled>保存设置</button><button id="settings-reload" disabled>重新读取</button></div>
<button id="settings-reset" class="secondary" disabled>恢复默认并保存</button>
<p id="settings-status" class="hint" role="status" aria-live="polite">正在读取本机设置…</p><p id="settings-path" class="path"></p>
<p class="hint">点击“保存设置”保存当前闭眼阈值、三个转头方向和左右眼交换；下次启动恢复最后一次成功保存的设置，不限定为 0.30。“恢复默认并保存”会将阈值设为 0.30、开启左右转头及抬头低头反转、关闭歪头反转和左右眼交换，并保存默认值。已有个人设置不会因新版默认改变而自动覆盖。不保存画面、追踪分数、校准或摄像头开启状态。</p></div>
<p class="hint">离开画面约 0.25 秒后平滑回正；停止、切换模型或窗口转到后台会释放摄像头。只驱动原有六参数。</p>`;
document.querySelector('aside').prepend(panel);
const $=id=>document.getElementById(id),video=$('camera-video'),mapping=new TrackerMapping();
$('reverse-x').checked=TRACKING_DEFAULTS.reverseX;
$('reverse-y').checked=SETTINGS_DEFAULTS.reverseY;
let frameBusy=false,lastSubmitted=-Infinity,lastVideoTime=-1,lastArrival=0,seen=false,latency=0,rate=0,frameCount=0,rateAt=performance.now();
let settingsClient=null;
const options=()=>({reverseX:$('reverse-x').checked,reverseY:$('reverse-y').checked,reverseZ:$('reverse-z').checked,swapEyes:$('swap-eyes').checked,eyeCloseThreshold:Number($('eye-threshold').value)});
const session=new CameraSession({
  acquire:()=>{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('浏览器不支持摄像头，请使用启动器打开的本地页面。');
    return navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}},audio:false});
  },
  createTracker:()=>new WorkerTracker(),
  attach:async stream=>{video.srcObject=stream;await video.play();},
  detach:()=>{video.pause();video.srcObject=null;mapping.reset();seen=false;lastVideoTime=-1;lastArrival=0;$('eye-signals').textContent='闭眼信号：等待追踪（不是眼睛开合参数）';bridge.reset();bridge.manual(true);},
  onState:(state,message)=>{
    $('camera-status').textContent=message;$('camera-stop').disabled=state==='idle';$('camera-start').disabled=state!=='idle'||!bridge.ready()||!settingsClient?.ready||settingsClient?.busy;
    bridge.manual(state==='idle');panel.classList.toggle('is-running',state==='running');
    if(state==='running'){lastArrival=performance.now();frameCount=0;rateAt=performance.now();}
  }
});
$('camera-start').addEventListener('click',()=>{if(bridge.ready()&&settingsClient?.ready&&!settingsClient?.busy)session.start();});
$('camera-stop').addEventListener('click',()=>session.stop());
$('calibrate').addEventListener('click',()=>mapping.calibrate(performance.now()));
$('clear-calibration').addEventListener('click',()=>{mapping.reset();bridge.reset();});
$('show-camera').addEventListener('change',()=>video.hidden=!$('show-camera').checked);
$('eye-threshold').addEventListener('input',()=>{$('eye-threshold-value').textContent=Number($('eye-threshold').value).toFixed(2);settingsClient?.changed();});
for(const id of ['reverse-x','reverse-y','reverse-z','swap-eyes'])$(id).addEventListener('change',()=>settingsClient?.changed());
function applySettings(value){
  $('eye-threshold').value=value.eyeCloseThreshold;$('eye-threshold-value').textContent=Number(value.eyeCloseThreshold).toFixed(2);
  for(const [id,key] of [['reverse-x','reverseX'],['reverse-y','reverseY'],['reverse-z','reverseZ'],['swap-eyes','swapEyes']])$(id).checked=value[key];
}
for(const id of ['eye-threshold','reverse-x','reverse-y','reverse-z','swap-eyes'])$(id).disabled=true;
$('settings-save').addEventListener('click',()=>settingsClient?.save());
$('settings-reset').addEventListener('click',()=>settingsClient?.save(true));
$('settings-reload').addEventListener('click',()=>settingsClient?.load());
for(const id of ['preset','folder'])$(id).addEventListener('change',()=>{if(session.state!=='idle')session.stop('模型切换已停止摄像头；模型加载后请重新开启。');},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&session.state!=='idle')session.stop('窗口已转到后台，摄像头已释放。返回后请手动开启。');});
addEventListener('pagehide',()=>session.stop());
async function capture(now){
  const generation=session.generation,tracker=session.tracker;frameBusy=true;lastSubmitted=now;lastVideoTime=video.currentTime;
  try {
    const bitmap=await createImageBitmap(video);
    if(generation!==session.generation){bitmap.close();return;}
    const data=await tracker.frame(bitmap,now);
    if(generation!==session.generation)return;
    lastArrival=performance.now();latency=data.latency;frameCount++;
    const o=observation(data.result);seen=!!o;mapping.accept(o,lastArrival,options());
    $('eye-signals').textContent=o?`输入闭眼信号：左 ${o.left.toFixed(3)} / 右 ${o.right.toFixed(3)}（越大表示越闭；仅内存显示）`:'闭眼信号：未检测到清晰人脸';
    if(lastArrival-rateAt>1000){rate=frameCount*1000/(lastArrival-rateAt);frameCount=0;rateAt=lastArrival;}
  } catch(error){if(generation===session.generation)session.stop(cameraError(error));}
  finally{frameBusy=false;}
}
function loop(now){
  if(session.state==='idle'){
    $('camera-start').disabled=!bridge.ready()||!settingsClient?.ready||settingsClient?.busy;
    if(bridge.ready()&&$('camera-status').textContent==='摄像头关闭，正在等待角色加载。')$('camera-status').textContent='角色已就绪。摄像头关闭，点击开启后才会请求权限。';
  }
  if(session.state==='running'){
    if(!bridge.ready())session.stop('渲染器暂不可用，摄像头已停止。');
    else if(now-lastArrival>6000)session.stop('摄像头画面或追踪结果超过 6 秒未更新，已安全停止。');
    else {
      const mapped=mapping.tick(now);bridge.apply(mapped.values);
      $('camera-status').textContent=mapped.lost?'未检测到清晰人脸，角色正在回到默认姿势。':'正在追踪：转头、眨眼或张嘴试试看。';
      $('track-stats').textContent=`追踪 ${rate.toFixed(1)} 次/秒 · 最近一次推理 ${latency.toFixed(1)} ms（不含摄像头采集与显示延迟）`;
      if(!frameBusy&&now-lastSubmitted>=40&&video.readyState>=2&&video.currentTime!==lastVideoTime)void capture(now);
    }
  }
  $('calibrate').disabled=session.state!=='running'||!seen||now-mapping.lastSeen>250||!!mapping.calibration;
  $('calibration-status').textContent=mapping.calibrationState;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
const config=await(await fetch('/api/config')).json();
settingsClient=new SettingsClient({token:config.settingsToken,readControls:options,applyControls:applySettings,onState:s=>{
  for(const id of ['settings-save','settings-reset','settings-reload','eye-threshold','reverse-x','reverse-y','reverse-z','swap-eyes'])$(id).disabled=s.busy||!s.ready;
  $('settings-status').textContent=s.message;$('settings-path').textContent=s.path;
}});
await settingsClient.load();
if(config.trackingVerification){const {run}=await import('./tracking-selftest.js');run({bridge,session,mapping,config,trackingOptions:options,settingsClient}).catch(async e=>{await fetch('/api/evidence',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':config.token},body:JSON.stringify({complete:true,error:String(e?.stack??e)})});});}
