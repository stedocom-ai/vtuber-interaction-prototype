import {TRACKING_DEFAULTS} from './mapping.js';
export const SETTINGS_DEFAULTS=Object.freeze({schemaVersion:1,eyeCloseThreshold:TRACKING_DEFAULTS.eyeCloseThreshold,reverseX:TRACKING_DEFAULTS.reverseX,reverseY:true,reverseZ:false,swapEyes:false});
export function validateSettings(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('设置必须是 JSON 对象。');
  const keys=Object.keys(SETTINGS_DEFAULTS);
  if(Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)))throw new Error('设置字段不完整或包含不支持的内容。');
  if(value.schemaVersion!==1)throw new Error('设置版本不受支持。');
  if(!Number.isFinite(value.eyeCloseThreshold)||value.eyeCloseThreshold<.15||value.eyeCloseThreshold>.8)throw new Error('闭眼阈值必须在 0.15～0.80 之间。');
  if(['reverseX','reverseY','reverseZ','swapEyes'].some(k=>typeof value[k]!=='boolean'))throw new Error('方向与眼睛交换设置必须是开关值。');
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
