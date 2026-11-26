export const DEFAULTS = Object.freeze({ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,ParamEyeLOpen:1,ParamEyeROpen:1,ParamMouthOpenY:0});
export const TRACKING_DEFAULTS = Object.freeze({reverseX:true,eyeCloseThreshold:.30});
export const EYE_OPEN_THRESHOLD=.08;
export const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
export function eyeOpenValue(score,closeThreshold=TRACKING_DEFAULTS.eyeCloseThreshold) {
  if(!Number.isFinite(score)||score<0||score>1)throw new Error('EYE_SCORE_INVALID');
  if(!Number.isFinite(closeThreshold)||closeThreshold<.15||closeThreshold>.8)throw new Error('EYE_THRESHOLD_INVALID: 闭眼阈值必须在 0.15～0.80 之间。');
  return 1-clamp((score-EYE_OPEN_THRESHOLD)/(closeThreshold-EYE_OPEN_THRESHOLD),0,1);
}
const deg = 180/Math.PI;
export const wrap = x => ((x+180)%360+360)%360-180;
// MediaPipe MatrixData default layout is column-major. Remove per-axis scale.
export function observation(result) {
  const m = result?.facialTransformationMatrixes?.[0];
  const d = m?.data;
  if (m?.rows !== 4 || m?.columns !== 4 || d?.length !== 16 || !Array.from(d).every(Number.isFinite)) return null;
  const n = [0,4,8].map(i=>Math.hypot(d[i],d[i+1],d[i+2]));
  if (n.some(v=>v<1e-6)) return null;
  const cats = result.faceBlendshapes?.[0]?.categories;
  const scores = Object.fromEntries((cats??[]).map(c=>[c.categoryName,c.score]));
  if (!['eyeBlinkLeft','eyeBlinkRight','jawOpen'].every(k=>Number.isFinite(scores[k]) && scores[k]>=0 && scores[k]<=1)) return null;
  return {x:Math.asin(clamp(-d[2]/n[0],-1,1))*deg, y:Math.atan2(d[6]/n[1],d[10]/n[2])*deg,
    z:Math.atan2(d[1]/n[0],d[0]/n[0])*deg, left:scores.eyeBlinkLeft,right:scores.eyeBlinkRight,jaw:scores.jawOpen};
}
export function mapObservation(o, neutral={x:0,y:0,z:0,jaw:0}, options={}) {
  if (!o || ![o.x,o.y,o.z,o.left,o.right,o.jaw].every(Number.isFinite)) throw new Error('TRACKING_DATA_INVALID');
  const eye = v=>eyeOpenValue(v,options.eyeCloseThreshold??TRACKING_DEFAULTS.eyeCloseThreshold);
  const result = {ParamAngleX:clamp(wrap(o.x-neutral.x)*((options.reverseX??TRACKING_DEFAULTS.reverseX)?-1:1),-30,30)+0,
    ParamAngleY:clamp(wrap(o.y-neutral.y)*(options.reverseY?-1:1),-30,30),
    ParamAngleZ:clamp(wrap(o.z-neutral.z)*(options.reverseZ?-1:1),-30,30),
    ParamEyeLOpen:eye(options.swapEyes?o.right:o.left), ParamEyeROpen:eye(options.swapEyes?o.left:o.right),
    ParamMouthOpenY:clamp((o.jaw-neutral.jaw-.03)/.42,0,1)};
  return result;
}
export class TrackerMapping {
  constructor(){this.reset();}
  reset(){this.neutral={x:0,y:0,z:0,jaw:0};this.values={...DEFAULTS};this.lastSeen=-Infinity;this.lastTick=null;this.target={...DEFAULTS};this.calibration=null;this.calibrationState='未校准';}
  calibrate(now){this.calibration={start:now,samples:[]};this.calibrationState='请正视、睁眼并闭嘴，保持约 1 秒';}
  accept(o,now,options={}) {
    if (!o) return;
    if (this.calibration) {
      const c=this.calibration; c.samples.push(o);
      if (now-c.start>=1000 && c.samples.length>=10) {
        const keys=['x','y','z','jaw'];
        if (keys.slice(0,3).some(k=>Math.max(...c.samples.map(s=>s[k]))-Math.min(...c.samples.map(s=>s[k]))>10) || c.samples.some(s=>Math.abs(s.x)>45||Math.abs(s.y)>45||s.jaw>.2)) this.calibrationState='校准失败：请正视镜头、闭嘴并保持稳定后重试';
        else {this.neutral=Object.fromEntries(keys.map(k=>[k,c.samples.reduce((sum,s)=>sum+s[k],0)/c.samples.length]));this.calibrationState='正视校准完成';}
        this.calibration=null;
      }
    }
    this.target=mapObservation(o,this.neutral,options);this.lastSeen=now;
  }
  tick(now) {
    if (this.calibration && now-this.calibration.start>4000) {this.calibration=null;this.calibrationState='校准超时：未持续检测到人脸，请重试';}
    const age=now-this.lastSeen, lost=age>250;
    const target=lost?DEFAULTS:this.target;
    const dt=this.lastTick===null?16:Math.max(0,now-this.lastTick);this.lastTick=now;
    for (const k of Object.keys(DEFAULTS)) {
      const tau=lost?180:k.includes('Eye')?35:80;
      this.values[k]+=(target[k]-this.values[k])*(1-Math.exp(-dt/tau));
      // Keep smoothing, but settle exactly on eye endpoints instead of an endless tiny residual.
      if(k.includes('Eye')&&(target[k]===0||target[k]===1)&&Math.abs(target[k]-this.values[k])<.005)this.values[k]=target[k];
    }
    return {values:{...this.values},lost,age};
  }
}
