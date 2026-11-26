// Project-owned validation shared by the browser and Node tests. No SDK code.
export const MOC_SHA256 = 'abe37e0ba38bd1d333e4f55ef00afa9ebe1521ef2ed839ae80798ccea9eb2e62';
export const PARAMETERS = [
  ['ParamAngleX', '头部左右'], ['ParamAngleY', '头部上下'], ['ParamAngleZ', '头部倾斜'],
  ['ParamEyeLOpen', '左眼开闭'], ['ParamEyeROpen', '右眼开闭'], ['ParamMouthOpenY', '嘴巴开闭'],
];
export function relativeFile(value) {
  if (typeof value !== 'string' || value.length > 240 || /[\\:\x00-\x1f?#%]/.test(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) {
    throw new Error('UNSAFE_PATH: 模型含不安全的文件路径，请选择完整的 reference-v1 模型文件夹。');
  }
  return value;
}
export function modelReferences(json) {
  const f = json?.FileReferences;
  if (json?.Version !== 3 || !f || typeof f !== 'object' || Array.isArray(f)) throw new Error('MODEL_INVALID: 不是有效的 model3.json。');
  if (Object.keys(f).some(k => !['Moc', 'Textures', 'DisplayInfo'].includes(k))) throw new Error('SCOPE_UNSUPPORTED: 本版仅验证 reference-v1，不支持动作文件、物理或其他扩展引用。');
  if (!Array.isArray(f.Textures) || f.Textures.length !== 1) throw new Error('TEXTURE_COUNT: reference-v1 必须包含一张纹理。');
  const refs = [relativeFile(f.Moc), ...f.Textures.map(relativeFile), relativeFile(f.DisplayInfo)];
  if (!refs[0].endsWith('.moc3') || !refs[1].endsWith('.png') || !refs[2].endsWith('.cdi3.json') || new Set(refs).size !== refs.length) throw new Error('REFERENCE_TYPE: 模型引用类型不符合 reference-v1。');
  return refs;
}
export function validateMocHash(hash) {
  if (hash !== MOC_SHA256) throw new Error('TEMPLATE_MISMATCH: 本版只支持已验收的 reference-v1 模板；这个 MOC3 不匹配。');
}
export function parameterMetadata(model) {
  const list = Array.from({ length: model.getParameterCount() }, (_, index) => ({
    index, id: String(model.getParameterId(index).getString()),
    min: model.getParameterMinimumValue(index), max: model.getParameterMaximumValue(index),
    default: model.getParameterDefaultValue(index),
  }));
  return PARAMETERS.map(([id, label]) => {
    const matches = list.filter(p => p.id === id);
    if (matches.length !== 1) throw new Error('PARAMETER_MISSING: 缺少或重复参数 ' + id);
    const p = matches[0];
    if (![p.min, p.max, p.default].every(Number.isFinite) || p.min >= p.max || p.default < p.min || p.default > p.max) throw new Error('PARAMETER_RANGE: 参数范围无效：' + id);
    return { ...p, label };
  });
}
export function parameterValue(p, value) {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < p.min || n > p.max) throw new Error('PARAMETER_VALUE: 参数值不在模型允许范围内。');
  return n;
}
export function projection(bounds, width, height, zoom = 1) {
  if (!(width > 0 && height > 0 && zoom >= 0.5 && zoom <= 2)) throw new Error('VIEW_INVALID: 无效的窗口尺寸或缩放。');
  const [left, bottom, right, top] = bounds;
  if (!(right > left && top > bottom)) throw new Error('BOUNDS_INVALID: 模型顶点范围无效。');
  const unit = Math.min(width * 0.8 / (right - left), height * 0.8 / (top - bottom)) * zoom;
  const sx = 2 * unit / width, sy = 2 * unit / height;
  return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -(left + right) * sx / 2, -(bottom + top) * sy / 2, 0, 1]);
}
