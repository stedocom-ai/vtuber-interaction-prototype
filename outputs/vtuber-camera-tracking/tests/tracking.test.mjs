import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,observation,mapObservation,TrackerMapping,wrap,eyeOpenValue,TRACKING_DEFAULTS} from '../web/mapping.js';
import {CameraSession,cameraError} from '../web/session.js';
import {startServer} from '../src/server.ts';
import {SETTINGS_DEFAULTS} from '../web/settings-schema.js';
const face={x:0,y:0,z:0,left:0,right:0,jaw:0};
const matrix=(x=0,y=0,z=0)=>{
  [x,y,z]=[x,y,z].map(d=>d*Math.PI/180);
  // Rz(roll) Ry(yaw) Rx(pitch), stored by columns.
  const cy=Math.cos(x),sy=Math.sin(x),cx=Math.cos(y),sx=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
  return [cz*cy,sz*cy,-sy,0,cz*sy*sx-sz*cx,sz*sy*sx+cz*cx,cy*sx,0,cz*sy*cx+sz*sx,sz*sy*cx-cz*sx,cy*cx,0,0,0,0,1];
};
const result=(data=matrix())=>({facialTransformationMatrixes:[{rows:4,columns:4,data}],faceBlendshapes:[{categories:['eyeBlinkLeft','eyeBlinkRight','jawOpen'].map(categoryName=>({categoryName,score:0}))}]});
test('neutral maps to six reference defaults',()=>assert.deepEqual(mapObservation(face),DEFAULTS));
for(const [name,angles] of [['yaw',[20,0,0]],['pitch',[0,-15,0]],['roll',[0,0,25]],['combined',[19,-12,23]]])test('column-major '+name,()=>{const o=observation(result(matrix(...angles)));[o.x,o.y,o.z].forEach((v,i)=>assert.ok(Math.abs(v-angles[i])<1e-8));});
test('scaled matrix preserves orientation',()=>{const d=matrix(10,15,-20);for(const i of [0,4,8])for(let j=0;j<3;j++)d[i+j]*=2;assert.ok(Math.abs(observation(result(d)).x-10)<1e-8);});
for(const [name,r] of [['empty',{}],['bad matrix',result([NaN])],['degenerate',result(Array(16).fill(0))],['missing score',{...result(),faceBlendshapes:[]}],['no face',{facialTransformationMatrixes:[],faceBlendshapes:[]}]])test('reject '+name,()=>assert.equal(observation(r),null));
test('left blink is independent',()=>{const v=mapObservation({...face,left:1});assert.equal(v.ParamEyeLOpen,0);assert.equal(v.ParamEyeROpen,1);});
test('right blink is independent',()=>{const v=mapObservation({...face,right:1});assert.equal(v.ParamEyeLOpen,1);assert.equal(v.ParamEyeROpen,0);});
test('swap eyes only swaps eyes',()=>{const a=mapObservation({...face,left:1}),b=mapObservation({...face,left:1},undefined,{swapEyes:true});assert.equal(b.ParamEyeROpen,a.ParamEyeLOpen);assert.equal(b.ParamEyeLOpen,1);});
test('open mouth reaches 1',()=>assert.equal(mapObservation({...face,jaw:1}).ParamMouthOpenY,1));
test('angles clamped with mirrored X default',()=>{const v=mapObservation({...face,x:80,y:-80,z:60});assert.deepEqual([v.ParamAngleX,v.ParamAngleY,v.ParamAngleZ],[-30,-30,30]);});
test('reversal flags independent',()=>{const v=mapObservation({...face,x:12,y:13,z:14},undefined,{reverseX:true,reverseY:true,reverseZ:true});assert.deepEqual([v.ParamAngleX,v.ParamAngleY,v.ParamAngleZ],[-12,-13,-14]);});
test('invalid numeric observation cannot write NaN',()=>assert.throws(()=>mapObservation({...face,x:NaN}),/INVALID/));
test('wrap handles 180 crossing',()=>assert.equal(wrap(-358),2));
test('calibration averages stable samples',()=>{const m=new TrackerMapping();m.calibrate(0);for(let i=0;i<=20;i++)m.accept({...face,x:8,y:4,jaw:.05},i*50);assert.equal(m.calibrationState,'正视校准完成');assert.ok(Math.abs(m.target.ParamAngleX)<1e-8);assert.equal(m.target.ParamMouthOpenY,0);});
test('moving calibration rejected',()=>{const m=new TrackerMapping();m.calibrate(0);for(let i=0;i<=20;i++)m.accept({...face,x:i},i*50);assert.match(m.calibrationState,/失败/);assert.equal(m.neutral.x,0);});
test('missing face calibration times out',()=>{const m=new TrackerMapping();m.calibrate(0);m.tick(4100);assert.match(m.calibrationState,/超时/);});
test('loss holds briefly then eases back',()=>{const m=new TrackerMapping();m.accept({...face,x:30,left:1,jaw:1},0);m.tick(0);assert.equal(m.tick(200).lost,false);assert.equal(m.tick(300).lost,true);for(let i=400;i<=2400;i+=16)m.tick(i);assert.ok(Math.abs(m.values.ParamAngleX)<.001);assert.ok(m.values.ParamEyeLOpen>.999);});
test('smooth mirrored response does not instantly jump',()=>{const m=new TrackerMapping();m.accept({...face,x:30},0);const v=m.tick(16).values.ParamAngleX;assert.ok(v<0&&v>-30);});
test('default X reversal matches user accepted checkbox without reversing Y or Z',()=>{const a=mapObservation({...face,x:12,y:13,z:14});assert.deepEqual([a.ParamAngleX,a.ParamAngleY,a.ParamAngleZ],[-12,13,14]);assert.equal(TRACKING_DEFAULTS.reverseX,true);});
test('user can disable default X reversal',()=>assert.equal(mapObservation({...face,x:12},undefined,{reverseX:false}).ParamAngleX,12));
test('v0.1.4 application defaults reverse pitch only compared with old settings; explicit false still works',()=>{
  const input={...face,x:12,y:13,z:14,left:.2,right:.1,jaw:.2};
  const current=mapObservation(input,undefined,SETTINGS_DEFAULTS),old=mapObservation(input,undefined,{...SETTINGS_DEFAULTS,reverseY:false});
  assert.equal(current.ParamAngleY,-13);assert.equal(old.ParamAngleY,13);
  assert.equal(mapObservation({...input,y:-13},undefined,SETTINGS_DEFAULTS).ParamAngleY,13);
  for(const key of Object.keys(DEFAULTS))if(key!=='ParamAngleY')assert.equal(current[key],old[key]);
});
test('reported old 0.6x and 0.3 eye residuals now reach zero (synthetic inferred scores)',()=>{for(const oldOpen of [.60,.65,.69,.30]){const score=.08+(1-oldOpen)*.72;assert.ok(Math.abs(eyeOpenValue(score,.8)-oldOpen)<1e-9);assert.equal(eyeOpenValue(score),0);}});
test('moderate blink closes one eye without affecting other eye or mouth',()=>{const a=mapObservation({...face,left:.34,jaw:.2}),b=mapObservation({...face,right:.34,jaw:.2});assert.deepEqual([a.ParamEyeLOpen,a.ParamEyeROpen],[0,1]);assert.deepEqual([b.ParamEyeLOpen,b.ParamEyeROpen],[1,0]);assert.equal(a.ParamMouthOpenY,b.ParamMouthOpenY);});
test('both moderate blink signals close both eyes',()=>{const v=mapObservation({...face,left:.34,right:.36});assert.equal(v.ParamEyeLOpen,0);assert.equal(v.ParamEyeROpen,0);});
test('naturally open low scores remain fully open',()=>{for(const v of [0,.04,.08])assert.equal(eyeOpenValue(v),1);});
test('eye mapping is continuous and monotonic within threshold',()=>{let last=1;for(let i=0;i<=100;i++){const v=eyeOpenValue(i/100);assert.ok(v>=0&&v<=1&&v<=last);last=v;}});
test('smaller threshold increases closure and only changes eye parameters',()=>{const a=mapObservation({...face,x:10,left:.25,jaw:.2},undefined,{eyeCloseThreshold:.2}),b=mapObservation({...face,x:10,left:.25,jaw:.2},undefined,{eyeCloseThreshold:.5});assert.equal(a.ParamEyeLOpen,0);assert.ok(b.ParamEyeLOpen>0);for(const k of ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamMouthOpenY'])assert.equal(a[k],b[k]);});
for(const value of [NaN,Infinity,.08,.14,.81,'0.3'])test('invalid eye threshold rejected '+String(value),()=>assert.throws(()=>eyeOpenValue(.3,value),/EYE_THRESHOLD_INVALID/));
test('eye smoothing settles to exact zero then one within 250ms',()=>{const m=new TrackerMapping();for(let t=0;t<=240;t+=16){m.accept({...face,left:.34},t);m.tick(t);}assert.equal(m.values.ParamEyeLOpen,0);assert.equal(m.values.ParamEyeROpen,1);for(let t=256;t<=496;t+=16){m.accept(face,t);m.tick(t);}assert.equal(m.values.ParamEyeLOpen,1);});
test('recovery reacquires',()=>{const m=new TrackerMapping();m.tick(1000);m.accept(face,1010);assert.equal(m.tick(1010).lost,false);});
test('reset clears tracking and calibration',()=>{const m=new TrackerMapping();m.calibrate(0);m.accept({...face,x:15},0);m.reset();assert.deepEqual(m.values,DEFAULTS);assert.equal(m.calibration,null);});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
function fixture(overrides={}){
  const counts={acquire:0,stop:0,closed:0,detach:0,attach:0};let ended;
  const stream={getTracks:()=>[{stop:()=>counts.stop++,addEventListener:(_,f)=>ended=f}]};
  const tracker={ready:Promise.resolve(),close:()=>counts.closed++};
  const session=new CameraSession({acquire:async()=>{counts.acquire++;return stream;},createTracker:()=>tracker,attach:async()=>{counts.attach++;},detach:()=>counts.detach++,onState:()=>{},...overrides});
  return{counts,stream,tracker,session,end:()=>ended()};
}
test('no automatic camera acquisition',()=>{const f=fixture();assert.equal(f.counts.acquire,0);assert.equal(f.session.state,'idle');});
test('start stop releases stream and worker',async()=>{const f=fixture();await f.session.start();assert.equal(f.session.state,'running');f.session.stop();assert.equal(f.counts.stop,1);assert.equal(f.counts.closed,1);assert.equal(f.session.state,'idle');});
test('duplicate start acquires once',async()=>{const f=fixture();await Promise.all([f.session.start(),f.session.start()]);assert.equal(f.counts.acquire,1);});
test('cancel permission then late stream stopped',async()=>{const d=deferred(),f=fixture({acquire:()=>d.promise});const p=f.session.start();f.session.stop();d.resolve(f.stream);await p;assert.equal(f.counts.stop,1);assert.equal(f.counts.attach,0);});
test('stop during worker loading',async()=>{const d=deferred(),f=fixture();f.tracker.ready=d.promise;const p=f.session.start();await Promise.resolve();f.session.stop();d.resolve();await p;assert.equal(f.counts.stop,1);assert.equal(f.counts.closed,1);assert.equal(f.counts.attach,0);});
test('worker startup failure releases camera',async()=>{const f=fixture({createTracker:()=>{throw new Error('worker failure');}});await f.session.start();assert.equal(f.counts.stop,1);assert.equal(f.session.state,'idle');});
test('permission denial safely returns idle',async()=>{const f=fixture({acquire:async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});}});await f.session.start();assert.equal(f.session.state,'idle');assert.equal(f.counts.attach,0);});
test('video attach failure releases resources',async()=>{const f=fixture({attach:async()=>{throw new Error('play failed');}});await f.session.start();assert.equal(f.counts.stop,1);assert.equal(f.counts.closed,1);});
test('video attach timeout releases resources',async t=>{t.mock.timers.enable({apis:['setTimeout']});const d=deferred(),f=fixture({attach:()=>d.promise});const p=f.session.start();await Promise.resolve();await Promise.resolve();t.mock.timers.tick(8001);await p;assert.equal(f.session.state,'idle');assert.equal(f.counts.stop,1);assert.equal(f.counts.closed,1);});
test('device ended stops session',async()=>{const f=fixture();await f.session.start();f.end();assert.equal(f.session.state,'idle');assert.equal(f.counts.stop,1);});
for(const name of ['NotAllowedError','NotFoundError','NotReadableError','OverconstrainedError','SecurityError','AbortError'])test('Chinese camera error '+name,()=>assert.match(cameraError({name}),/[\u4e00-\u9fff]/));
test('loopback server safety and frozen model routes',async()=>{
  const app=await startServer();try{
    const res=await fetch(app.url);assert.equal(res.status,200);assert.match(res.headers.get('permissions-policy'),/camera=\(self\)/);assert.match(res.headers.get('permissions-policy'),/microphone=\(\)/);
    assert.match(res.headers.get('content-security-policy'),/connect-src 'self'/);
    const config=await(await fetch(app.url+'/api/config')).json();assert.equal(config.verification,false);assert.equal(config.trackingVerification,false);assert.equal(config.presets.length,5);
    for(const uri of ['/tracking-selftest.js','/vendor/package.json','/models/gold/../../secret','/api/unknown'])assert.equal((await fetch(app.url+uri)).status,404);
    assert.equal((await fetch(app.url,{method:'POST'})).status,405);assert.equal((await fetch(app.url,{headers:{Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(app.url+'/tracker-model/face_landmarker.task')).status,200);
    const js=await(await fetch(app.url+'/app.js')).text();assert.match(js,/export const previewBridge/);
  }finally{await app.close();}
});
