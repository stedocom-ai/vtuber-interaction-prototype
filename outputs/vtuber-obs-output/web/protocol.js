export const MODEL_ID = 'gold';
export const STALE_MS = 1500;
export const DEFAULT_POSE = Object.freeze({
  ParamAngleX: 0,
  ParamAngleY: 0,
  ParamAngleZ: 0,
  ParamEyeLOpen: 1,
  ParamEyeROpen: 1,
  ParamMouthOpenY: 0,
});

const fields = Object.keys(DEFAULT_POSE);

export function validatePose(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== fields.length ||
      !fields.every(key => Object.hasOwn(value, key))) {
    throw new Error('输出姿势必须且只能包含六个标准参数。');
  }
  const result = {...DEFAULT_POSE};
  for (const key of fields) {
    const number = value[key];
    const minimum = key.startsWith('ParamAngle') ? -30 : 0;
    const maximum = key.startsWith('ParamAngle') ? 30 : 1;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(`参数 ${key} 必须是 ${minimum}～${maximum} 之间的有限数值。`);
    }
    result[key] = number;
  }
  return result;
}

export function validateClientId(value) {
  const match = typeof value === 'string' && /^[A-Za-z0-9-]{8,80}$/.exec(value);
  if (!match || match[0] !== value) {
    throw new Error('输出连接标识必须是 8～80 位 ASCII 字母、数字或连字符。');
  }
  return value;
}
